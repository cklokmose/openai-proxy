import fs from 'fs';
import express from 'express';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { scheduleRequest, getQueueStatus, shutdown as shutdownRateLimiter, isRateLimitingEnabled, getRateLimitConfig } from './rate-limit.js';
import { getMetrics, recordRequest, recordLatency, recordTokenUsage, recordDroppedRequest, stopMetrics, areMetricsEnabled } from './metrics.js';
import { isAllowlistEnabled, isEndpointAllowed, validateAndNormalizeRequest, getAllowlistStatus } from './allowlist.js';
import { OpenAIHttpClient } from './http-client.js';

// --- Path setup and config file locations ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');
const LOG_PATH = path.join(__dirname, 'access.log');
const DB_PATH = path.join(__dirname, 'usage.sqlite');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Ensure keys.json exists with example users ---
if (!fs.existsSync(KEYS_PATH)) {
  fs.writeFileSync(KEYS_PATH, JSON.stringify([
    { key: "user-api-key-1", name: "Alice", email: "alice@example.com" },
    { key: "user-api-key-2", name: "Bob", email: "bob@example.com" }
  ], null, 2));
  console.log('✅ Created default keys.json');
}

// --- Load configuration and initialize HTTP client ---
let OPENAI_API_KEY = 'sk-...';
let httpClientConfig = {};
try {
  const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(configRaw);
  if (config.OPENAI_API_KEY) {
    OPENAI_API_KEY = config.OPENAI_API_KEY;
  }
  
  // Load HTTP client configuration
  if (config.HTTP_CLIENT) {
    httpClientConfig = config.HTTP_CLIENT;
  }
} catch (err) {
  console.warn('⚠️ Could not load config.json or OPENAI_API_KEY not set. Using default or environment variable.');
  OPENAI_API_KEY = process.env.OPENAI_API_KEY || OPENAI_API_KEY;
}

// Initialize HTTP client (can be overridden for testing)
let httpClient = null;

function createHttpClient(customConfig = {}) {
  const clientConfig = {
    host: 'api.openai.com',
    apiKey: OPENAI_API_KEY,
    timeout: 120000,
    maxRetries: 3,
    ...httpClientConfig,
    ...customConfig
  };
  return new OpenAIHttpClient(clientConfig);
}

// Create default HTTP client
httpClient = createHttpClient();

let VALID_KEYS = new Map();

// --- Initialize SQLite DB for usage logging ---
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT,
    date TEXT,
    model TEXT,
    endpoint TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER
  )`);
});

// --- Log usage to DB if model and tokens are valid ---
function logToDB(apiKey, model, endpoint, prompt, completion) {
  // Only log if model is a non-empty string and at least one token is nonzero
  if (!model || model === 'unknown') return;
  if ((prompt === 0 && completion === 0)) return;
  const date = new Date().toISOString().split('T')[0];
  const total = prompt + completion;
  db.run(
    `INSERT INTO usage_log (api_key, date, model, endpoint, prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [apiKey, date, model, endpoint, prompt, completion, total]
  );
}

// --- Load API keys from keys.json into memory ---
function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    VALID_KEYS = new Map(parsed.map(k => [k.key, { name: k.name, email: k.email }]));
    console.log(`🔑 Loaded ${VALID_KEYS.size} API key(s)`);
  } catch (err) {
    console.error('❌ Failed to load keys.json:', err.message);
    VALID_KEYS = new Map();
  }
}
loadKeys();
// --- Hot-reload keys.json on change ---
fs.watchFile(KEYS_PATH, { interval: 1000 }, () => {
  console.log('🔄 Reloading keys.json...');
  loadKeys();
});

const app = express();
app.use(express.json({ limit: '50mb' })); // Large payloads for images

// Add multer for handling multipart/form-data with temporary disk storage
const upload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tempDir = path.join(__dirname, 'temp-uploads');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      cb(null, tempDir);
    },
    filename: (req, file, cb) => {
      // Create unique filename with timestamp and random string
      const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2)}-${file.originalname}`;
      cb(null, uniqueName);
    }
  }),
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 5 // Max 5 files per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow audio files for audio endpoints
    if (req.url.includes('/audio/')) {
      const allowedMimes = [
        'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 
        'audio/flac', 'audio/ogg', 'audio/webm'
      ];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported audio format: ${file.mimetype}`));
      }
    } else {
      cb(null, true);
    }
  }
});

// --- CORS and preflight handling ---
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Api-Key, User-Agent');
    return res.status(204).end();
  }
  next();
});

// --- Metrics endpoint ---
app.get('/metrics', async (req, res) => {
  if (!areMetricsEnabled()) {
    return res.status(404).json({ error: 'Metrics endpoint is disabled' });
  }
  
  res.setHeader('Content-Type', 'text/plain');
  const metrics = await getMetrics();
  res.end(metrics);
});

// --- Health check endpoint ---
app.get('/health', (req, res) => {
  const queueStatus = getQueueStatus();
  const allowlistStatus = getAllowlistStatus();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    queue: queueStatus,
    allowlist: allowlistStatus
  });
});

// --- Main proxy handler ---
app.use(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Robustly extract API key from headers (case-insensitive, trim, support common variants)
  function getApiKeyFromHeaders(headers) {
    // Try common header names, case-insensitive
    const possibleNames = ['api-key', 'x-api-key', 'apikey', 'authorization'];
    for (const name of possibleNames) {
      if (headers[name]) return headers[name].trim();
      // Try all-lowercase
      if (headers[name.toLowerCase()]) return headers[name.toLowerCase()].trim();
      // Try all-uppercase
      if (headers[name.toUpperCase()]) return headers[name.toUpperCase()].trim();
      // Try capitalized
      const cap = name.charAt(0).toUpperCase() + name.slice(1);
      if (headers[cap]) return headers[cap].trim();
    }
    return '';
  }

  const userKey = getApiKeyFromHeaders(req.headers);
  console.log('[DEBUG] Received API key:', userKey);
  const user = VALID_KEYS.get(userKey);
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const timestamp = new Date().toISOString();
  const startTime = Date.now();

  console.log(`[DEBUG] Incoming request: ${req.method} ${req.url} from ${ip}`);
  console.log(`[DEBUG] Headers:`, req.headers);

  if (!user) {
    const line = `[${timestamp}] ❌ Invalid or missing API key from ${ip} → ${req.method} ${req.url}`;
    console.warn(line);
    fs.writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
    recordRequest(req.method, req.url, 403, 'unknown');
    return res.status(403).json({ error: 'Invalid or missing API key' });
  }

  // Check if endpoint is allowed (if allowlist is enabled)
  if (!isEndpointAllowed(req.url)) {
    const line = `[${timestamp}] 🚫 Endpoint not allowed: ${user.name} from ${ip} → ${req.method} ${req.url}`;
    console.warn(line);
    fs.writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
    recordRequest(req.method, req.url, 403, userKey);
    return res.status(403).json({ 
      error: `Endpoint not allowed: ${req.url}`,
      allowed_endpoints: isAllowlistEnabled() ? getAllowlistStatus().endpoints : "Allowlist disabled"
    });
  }

  // Wrap the entire request processing in rate limiting (if enabled)
  try {
    const processRequest = async () => {
      // Handle multipart/form-data for audio endpoints
      const isMultipartEndpoint = req.url.includes('/audio/') && 
        req.headers['content-type']?.startsWith('multipart/form-data');

      if (isMultipartEndpoint) {
        // Check basic upload rate limit for uploads (keeping the existing simple check)
        if (!checkUploadRateLimit(userKey)) {
          const line = `[${timestamp}] ⚠️ Rate limit exceeded for ${user.name} from ${ip} → ${req.method} ${req.url}`;
          console.warn(line);
          fs.writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
          recordRequest(req.method, req.url, 429, userKey);
          res.status(429).json({ error: 'Too many concurrent uploads. Please wait and try again.' });
          return;
        }
        
        // Use multer to parse multipart data
        upload.any()(req, res, (err) => {
          // Always release the upload slot
            releaseUploadSlot(userKey);
            
            if (err) {
              console.error('Multer error:', err);
              const responseTime = (Date.now() - startTime) / 1000;
              recordRequest(req.method, req.url, 400, userKey);
              recordLatency(req.method, req.url, 400, responseTime);
              return res.status(400).json({ error: `Failed to parse multipart data: ${err.message}` });
            }
            // Handle multipart in async wrapper
            (async () => {
              await handleMultipartRequest(req, res, user, userKey, timestamp, ip, startTime);
            })().catch(error => {
              console.error('Error in multipart handler:', error);
              if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
              }
            });
          });
        } else {
          await handleJsonRequest(req, res, user, userKey, timestamp, ip, startTime);
        }
    };

    // Use rate limiting if enabled, otherwise process directly
    if (isRateLimitingEnabled()) {
      await scheduleRequest(userKey, processRequest);
    } else {
      await processRequest();
    }
  } catch (error) {
    const responseTime = (Date.now() - startTime) / 1000;
    
    if (error.code === 'QUEUE_OVERFLOW') {
      console.warn(`⚠️ Queue overflow for ${user.name} from ${ip} → ${req.method} ${req.url}`);
      recordDroppedRequest('user');
      recordRequest(req.method, req.url, 503, userKey);
      recordLatency(req.method, req.url, 503, responseTime);
      return res.status(503).json({ 
        error: 'Service temporarily overloaded. Please wait and try again.',
        retryAfter: 30 
      });
    }
    
    console.error('❌ Rate limiting error:', error.message);
    recordRequest(req.method, req.url, 500, userKey);
    recordLatency(req.method, req.url, 500, responseTime);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

async function handleJsonRequest(req, res, user, userKey, timestamp, ip, startTime) {
  // For GET and DELETE requests, there's no body to process
  if (req.method === 'GET' || req.method === 'DELETE') {
    console.log(`[DEBUG] Handling ${req.method} request to ${req.url}`);
    const logLine = `[${timestamp}] ✅ ${user.name} <${user.email}> from ${ip} → ${req.method} ${req.url}`;
    fs.writeFileSync(LOG_PATH, logLine + '\n', { flag: 'a' });
    
    // Pass method and empty body to handler
    await handleJsonRequestWithClient(httpClient, req, res, null, user, userKey, timestamp, startTime, req.method);
    return;
  }

  // Utility: Redact base64 image data in request body for logging, but log a short prefix for traceability
  function redactBase64Images(obj) {
    if (Array.isArray(obj)) {
      return obj.map(redactBase64Images);
    } else if (obj && typeof obj === 'object') {
      const redacted = {};
      for (const [key, value] of Object.entries(obj)) {
        // Common fields for image data
        if (
          (key === 'image' || key === 'data' || key === 'content' || key === 'image_data') &&
          typeof value === 'string' &&
          value.length > 100 &&
          /^(data:image\/(png|jpeg|jpg|webp);base64,|[A-Za-z0-9+/=]{100,})/.test(value)
        ) {
          // Log only the first 32 base64 chars for traceability
          const prefix = value.slice(0, 32);
          redacted[key] = `[BASE64_IMAGE_REDACTED: prefix=${prefix}...]`;
        } else {
          redacted[key] = redactBase64Images(value);
        }
      }
      return redacted;
    }
    return obj;
  }

  // Use body parsed by express.json()
  const originalBody = req.body || {};
  
  // Validate and normalize request (model allowlist, etc.)
  const validation = validateAndNormalizeRequest(originalBody, req.url);
  if (!validation.valid) {
    const line = `[${timestamp}] 🚫 Request validation failed: ${user.name} from ${ip} → ${req.method} ${req.url} | ${validation.error}`;
    console.warn(line);
    fs.writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
    recordRequest(req.method, req.url, 403, userKey);
    return res.status(403).json({ 
      error: {
        message: validation.error,
        type: "invalid_request_error"
      }
    });
  }
  
  const normalizedBody = validation.body;
  const bodyString = JSON.stringify(normalizedBody);
  
  // Log model normalization if it occurred
  if (originalBody.model !== normalizedBody.model) {
    console.log(`[INFO] Model normalized: "${originalBody.model || 'undefined'}" → "${normalizedBody.model}"`);
  }
  
  // Redact base64 image data for logging
  const redactedBody = redactBase64Images(normalizedBody);
  const redactedBodyString = JSON.stringify(redactedBody);

  // Serialize request body for proxying
  const bodyBuffer = Buffer.from(bodyString);

  // Only print a short preview of the redacted body to the console for debugging
  const debugPreview = redactedBodyString.slice(0, 512);
  console.log(`[DEBUG] Request body (redacted, preview):`, debugPreview + (redactedBodyString.length > 512 ? ' ...[truncated]' : ''));

  // Only log the full redacted body to the file, not to the console
  const logLine = `[${timestamp}] ✅ ${user.name} <${user.email}> from ${ip} → ${req.method} ${req.url} | body: ${redactedBodyString}`;
  fs.writeFileSync(LOG_PATH, logLine + '\n', { flag: 'a' });

  console.log(`[DEBUG] Forwarding request to OpenAI via HTTP client: ${req.url}`);
  console.log(`[DEBUG] Request size: ${Buffer.byteLength(bodyBuffer)} bytes`);
  
  // Check if this is a streaming request
  if (normalizedBody.stream === true) {
    console.log(`[DEBUG] Streaming request detected`);
    await handleStreamingRequestWithClient(httpClient, req, res, normalizedBody, user, userKey, timestamp, startTime);
  } else {
    // Use the HTTP client with retry and backoff
    await handleJsonRequestWithClient(httpClient, req, res, normalizedBody, user, userKey, timestamp, startTime);
  }
}

async function handleStreamingRequestWithClient(client, req, res, requestBody, user, userKey, timestamp, startTime) {
  try {
    const response = await client.makeStreamingRequest(req.url, requestBody);
    const responseTime = Date.now() - startTime;
    const responseTimeSeconds = responseTime / 1000;
    
    console.log(`[DEBUG] Streaming request initiated with status: ${response.statusCode}`);
    
    // Record request metrics
    recordRequest(req.method, req.url, response.statusCode, userKey);
    recordLatency(req.method, req.url, response.statusCode, responseTimeSeconds);
    
    if (response.statusCode >= 400) {
      // Handle error response
      const chunks = [];
      response.stream.on('data', chunk => chunks.push(chunk));
      response.stream.on('end', () => {
        const errorBody = Buffer.concat(chunks).toString();
        console.error('💥 Streaming request failed:', errorBody);
        
        if (!res.headersSent) {
          res.writeHead(response.statusCode, response.headers);
          res.end(errorBody);
        }
      });
      return;
    }
    
    // Set up SSE headers for streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no' // Disable Nginx buffering
    });
    
    // Variables to track usage
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let model = requestBody.model || 'unknown';
    
    // Pipe the stream directly to the client
    response.stream.on('data', (chunk) => {
      // Forward the chunk to the client
      res.write(chunk);
      
      // Try to extract usage information from SSE data
      const chunkStr = chunk.toString();
      const lines = chunkStr.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.usage) {
              promptTokens = data.usage.prompt_tokens || promptTokens;
              completionTokens = data.usage.completion_tokens || completionTokens;
              totalTokens = data.usage.total_tokens || totalTokens;
            }
            if (data.model) {
              model = data.model;
            }
          } catch (e) {
            // Ignore parsing errors for incomplete chunks
          }
        }
      }
    });
    
    response.stream.on('end', () => {
      // Log usage if we collected any
      if (totalTokens > 0) {
        // Record token usage metrics
        if (promptTokens > 0) recordTokenUsage('prompt', model, userKey, promptTokens);
        if (completionTokens > 0) recordTokenUsage('completion', model, userKey, completionTokens);
        if (totalTokens > 0) recordTokenUsage('total', model, userKey, totalTokens);

        const usageLine = `[${timestamp}] 📊 ${user.name} used ${totalTokens} tokens (${promptTokens}+${completionTokens}) on ${model} [streaming]`;
        console.log(usageLine);
        fs.writeFileSync(LOG_PATH, usageLine + '\n', { flag: 'a' });

        logToDB(userKey, model, req.url, promptTokens, completionTokens);
      }
      
      res.end();
    });
    
    response.stream.on('error', (error) => {
      console.error('💥 Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });
    
  } catch (error) {
    console.error('💥 Streaming error:', error.message);
    const responseTime = (Date.now() - startTime) / 1000;
    const statusCode = error.statusCode || 502;
    
    recordRequest(req.method, req.url, statusCode, userKey);
    recordLatency(req.method, req.url, statusCode, responseTime);
    
    if (!res.headersSent) {
      res.status(statusCode).json({
        error: {
          message: error.message,
          type: 'streaming_error',
          details: error.details
        }
      });
    }
  }
}

async function handleJsonRequestWithClient(client, req, res, requestBody, user, userKey, timestamp, startTime, method = null) {
  try {
    // Use provided method or fall back to req.method, default to POST
    const httpMethod = method || req.method || 'POST';
    
    const response = await client.makeJsonRequest(req.url, requestBody, { method: httpMethod });
    const responseTime = Date.now() - startTime;
    const responseTimeSeconds = responseTime / 1000;
    
    console.log(`[DEBUG] Request completed in ${responseTime}ms with status: ${response.statusCode}`);
    
    // Record request metrics
    recordRequest(req.method, req.url, response.statusCode, userKey);
    recordLatency(req.method, req.url, response.statusCode, responseTimeSeconds);
    
    const contentType = response.headers['content-type'] || '';
    if (contentType.startsWith('application/json') || contentType.startsWith('text/')) {
      // Handle as text/JSON
      const responseText = response.text;
      console.log(`[DEBUG] Response from OpenAI:`, responseText);
      
      try {
        const json = response.json();
        const usage = json.usage || {};
        const model = json.model || 'unknown';
        const prompt = usage.prompt_tokens || 0;
        const completion = usage.completion_tokens || 0;
        const total = prompt + completion;

        // Record token usage metrics
        if (prompt > 0) recordTokenUsage('prompt', model, userKey, prompt);
        if (completion > 0) recordTokenUsage('completion', model, userKey, completion);
        if (total > 0) recordTokenUsage('total', model, userKey, total);

        const usageLine = `[${timestamp}] 📊 ${user.name} used ${total} tokens (${prompt}+${completion}) on ${model}`;
        console.log(usageLine);
        fs.writeFileSync(LOG_PATH, usageLine + '\n', { flag: 'a' });

        logToDB(userKey, model, req.url, prompt, completion);
      } catch (err) {
        console.error('⚠️ Failed to parse OpenAI response:', err.message);
      }
      
      res.writeHead(response.statusCode, response.headers);
      res.end(responseText);
    } else {
      // Binary data: forward as-is
      console.log(`[DEBUG] Binary response from OpenAI, content-type: ${contentType}, length: ${response.data.length}`);
      res.writeHead(response.statusCode, response.headers);
      res.end(response.data);
    }
    
  } catch (error) {
    console.error('💥 HTTP Client error:', error.message);
    console.error('💥 Error details:', {
      statusCode: error.statusCode,
      code: error.code,
      response: error.response ? 'Present' : 'None'
    });
    
    const responseTime = (Date.now() - startTime) / 1000;
    const statusCode = error.statusCode || 502;
    
    recordRequest(req.method, req.url, statusCode, userKey);
    recordLatency(req.method, req.url, statusCode, responseTime);
    
    if (!res.headersSent) {
      if (error.statusCode && error.response) {
        // Forward OpenAI error response
        try {
          const errorResponse = error.details || { error: { message: error.message } };
          res.status(error.statusCode).json(errorResponse);
        } catch (e) {
          res.status(error.statusCode).end(error.response.text);
        }
      } else {
        // Network or other error
        res.status(502).json({ 
          error: { 
            message: 'Failed to connect to OpenAI', 
            type: 'network_error',
            code: error.code 
          } 
        });
      }
    }
  }
}

async function handleMultipartRequest(req, res, user, userKey, timestamp, ip, startTime) {
  const uploadedFiles = req.files || [];
  
  // Cleanup function to remove temporary files
  const cleanupFiles = () => {
    for (const file of uploadedFiles) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
          console.log(`🧹 Cleaned up temp file: ${file.filename}`);
        }
      } catch (err) {
        console.warn(`⚠️ Failed to cleanup ${file.filename}:`, err.message);
      }
    }
  };
  
  console.log(`[DEBUG] Handling multipart request for audio endpoint`);
  console.log(`[DEBUG] Form fields:`, req.body);
  console.log(`[DEBUG] Files:`, uploadedFiles.map(f => ({ 
    fieldname: f.fieldname, 
    filename: f.filename,
    originalname: f.originalname,
    size: f.size, 
    mimetype: f.mimetype 
  })));

  // Validate model if allowlist is enabled
  if (isAllowlistEnabled()) {
    if (req.body && req.body.model) {
      try {
        const validation = validateAndNormalizeRequest(req.body);
        if (!validation.valid) {
          cleanupFiles();
          console.log(`❌ Model not allowed: ${req.body.model} (user: ${user.name})`);
          return res.status(403).json({
            error: {
              message: validation.error || `Model '${req.body.model}' is not allowed`,
              type: "invalid_request_error"
            }
          });
        }
        // Update the form data with normalized model
        req.body.model = validation.body.model;
        console.log(`✅ Model validated: ${req.body.model}`);
      } catch (err) {
        cleanupFiles();
        console.error('❌ Error validating model:', err.message);
        return res.status(400).json({
          error: {
            message: "Invalid request format",
            type: "invalid_request_error"
          }
        });
      }
    }
  }

  // Reconstruct multipart form data
  const boundary = '----formdata-openai-proxy-' + Math.random().toString(36);
  let formData = '';
  
  try {
    // Add form fields
    for (const [key, value] of Object.entries(req.body || {})) {
      formData += `--${boundary}\r\n`;
      formData += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
      formData += `${value}\r\n`;
    }
    
    // Add files - read from disk instead of memory
    for (const file of uploadedFiles) {
      formData += `--${boundary}\r\n`;
      formData += `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.originalname || 'audio.wav'}"\r\n`;
      formData += `Content-Type: ${file.mimetype || 'audio/wav'}\r\n\r\n`;
      
      // Read file from disk
      const fileBuffer = fs.readFileSync(file.path);
      formData += fileBuffer.toString('binary') + '\r\n';
    }
    
    formData += `--${boundary}--\r\n`;
    
    const bodyBuffer = Buffer.from(formData, 'binary');
    
    // Log request (without file data)
    const logData = { ...req.body, files: uploadedFiles.map(f => ({ name: f.fieldname, size: f.size })) };
    const logLine = `[${timestamp}] ✅ ${user.name} <${user.email}> from ${ip} → ${req.method} ${req.url} | multipart: ${JSON.stringify(logData)}`;
    fs.writeFileSync(LOG_PATH, logLine + '\n', { flag: 'a' });

    console.log(`[DEBUG] Forwarding multipart request to OpenAI via HTTP client: ${req.url}`);
    
    // Use the HTTP client with retry and backoff
    await handleMultipartRequestWithClient(httpClient, req, res, bodyBuffer, boundary, user, userKey, timestamp, startTime, cleanupFiles);
    
  } catch (err) {
    console.error('💥 Error processing multipart request:', err.message);
    const responseTime = (Date.now() - startTime) / 1000;
    recordRequest(req.method, req.url, 500, userKey);
    recordLatency(req.method, req.url, 500, responseTime);
    cleanupFiles(); // Cleanup on processing error
    res.status(500).json({ error: 'Internal server error processing upload' });
  }
}

async function handleMultipartRequestWithClient(client, req, res, bodyBuffer, boundary, user, userKey, timestamp, startTime, cleanupFiles) {
  try {
    const response = await client.makeMultipartRequest(req.url, bodyBuffer, boundary);
    
    // Cleanup temp files after successful response
    cleanupFiles();
    
    const responseTime = Date.now() - startTime;
    const responseTimeSeconds = responseTime / 1000;
    
    console.log(`[DEBUG] Multipart request completed in ${responseTime}ms with status: ${response.statusCode}`);
    
    // Record request metrics
    recordRequest(req.method, req.url, response.statusCode, userKey);
    recordLatency(req.method, req.url, response.statusCode, responseTimeSeconds);
    
    const contentType = response.headers['content-type'] || '';
    if (contentType.startsWith('application/json') || contentType.startsWith('text/')) {
      // Handle as text/JSON
      const responseText = response.text;
      console.log(`[DEBUG] Response from OpenAI:`, responseText);
      
      try {
        const json = response.json();
        // Audio endpoints may not have usage data, but log if available
        const usage = json.usage || {};
        const model = req.body?.model || 'unknown';
        const prompt = usage.prompt_tokens || 0;
        const completion = usage.completion_tokens || 0;
        const total = prompt + completion;

        if (total > 0) {
          // Record token usage metrics
          if (prompt > 0) recordTokenUsage('prompt', model, userKey, prompt);
          if (completion > 0) recordTokenUsage('completion', model, userKey, completion);
          if (total > 0) recordTokenUsage('total', model, userKey, total);

          const usageLine = `[${timestamp}] 📊 ${user.name} used ${total} tokens (${prompt}+${completion}) on ${model}`;
          console.log(usageLine);
          fs.writeFileSync(LOG_PATH, usageLine + '\n', { flag: 'a' });
          logToDB(userKey, model, req.url, prompt, completion);
        }
      } catch (err) {
        console.error('⚠️ Failed to parse OpenAI response:', err.message);
      }
      
      res.writeHead(response.statusCode, response.headers);
      res.end(responseText);
    } else {
      // Binary data: forward as-is
      console.log(`[DEBUG] Binary response from OpenAI, content-type: ${contentType}, length: ${response.data.length}`);
      res.writeHead(response.statusCode, response.headers);
      res.end(response.data);
    }
    
  } catch (error) {
    console.error('💥 HTTP Client error in multipart request:', error.message);
    console.error('💥 Error details:', {
      statusCode: error.statusCode,
      code: error.code,
      response: error.response ? 'Present' : 'None'
    });
    
    const responseTime = (Date.now() - startTime) / 1000;
    const statusCode = error.statusCode || 502;
    
    recordRequest(req.method, req.url, statusCode, userKey);
    recordLatency(req.method, req.url, statusCode, responseTime);
    
    // Always cleanup on error
    cleanupFiles();
    
    if (!res.headersSent) {
      if (error.statusCode && error.response) {
        // Forward OpenAI error response
        try {
          const errorResponse = error.details || { error: { message: error.message } };
          res.status(error.statusCode).json(errorResponse);
        } catch (e) {
          res.status(error.statusCode).end(error.response.text);
        }
      } else {
        // Network or other error
        res.status(502).json({ 
          error: { 
            message: 'Failed to connect to OpenAI', 
            type: 'network_error',
            code: error.code 
          } 
        });
      }
    }
  }
}

// --- Cleanup and rate limiting ---
let activeUploads = new Map(); // Track active uploads per user
const UPLOAD_RATE_LIMIT = 10; // Max 10 concurrent uploads per user
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup every 5 minutes
const TEMP_FILE_MAX_AGE = 10 * 60 * 1000; // Delete temp files after 10 minutes

// Cleanup temporary files periodically
function cleanupTempFiles() {
  const tempDir = path.join(__dirname, 'temp-uploads');
  if (!fs.existsSync(tempDir)) return;
  
  const now = Date.now();
  const files = fs.readdirSync(tempDir);
  let cleaned = 0;
  
  for (const file of files) {
    const filePath = path.join(tempDir, file);
    try {
      const stats = fs.statSync(filePath);
      const age = now - stats.mtime.getTime();
      
      if (age > TEMP_FILE_MAX_AGE) {
        fs.unlinkSync(filePath);
        cleaned++;
        console.log(`🧹 Cleaned up old temp file: ${file}`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to cleanup ${file}:`, err.message);
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleanup complete: removed ${cleaned} temporary files`);
  }
}

// Log rotation to prevent access.log from growing too large
function rotateLogs() {
  const maxLogSize = 100 * 1024 * 1024; // 100MB
  
  try {
    const stats = fs.statSync(LOG_PATH);
    if (stats.size > maxLogSize) {
      const backupPath = `${LOG_PATH}.${Date.now()}.bak`;
      fs.renameSync(LOG_PATH, backupPath);
      console.log(`📋 Rotated access log to ${backupPath}`);
      
      // Keep only last 5 backup files
      const backupFiles = fs.readdirSync(__dirname)
        .filter(f => f.startsWith('access.log.') && f.endsWith('.bak'))
        .sort()
        .reverse();
        
      if (backupFiles.length > 5) {
        for (const file of backupFiles.slice(5)) {
          fs.unlinkSync(path.join(__dirname, file));
          console.log(`🗑️ Deleted old log backup: ${file}`);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Log rotation failed:', err.message);
  }
}

// Rate limiting check
function checkUploadRateLimit(userKey) {
  const currentUploads = activeUploads.get(userKey) || 0;
  if (currentUploads >= UPLOAD_RATE_LIMIT) {
    return false;
  }
  activeUploads.set(userKey, currentUploads + 1);
  return true;
}

function releaseUploadSlot(userKey) {
  const currentUploads = activeUploads.get(userKey) || 0;
  if (currentUploads > 0) {
    activeUploads.set(userKey, currentUploads - 1);
  }
}

// Start cleanup intervals
setInterval(cleanupTempFiles, CLEANUP_INTERVAL);
setInterval(rotateLogs, CLEANUP_INTERVAL);

// Cleanup on shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  try {
    await shutdownRateLimiter();
    stopMetrics();
    cleanupTempFiles();
    console.log('✅ Graceful shutdown completed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Server terminated...');
  try {
    await shutdownRateLimiter();
    stopMetrics();
    cleanupTempFiles();
    console.log('✅ Graceful shutdown completed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
  }
  process.exit(0);
});

// Export functions for testing
export function setHttpClient(client) { 
  httpClient = client; 
}

export function getHttpClient() { 
  return httpClient; 
}

export { createHttpClient };

app.listen(8080, () => {
  console.log('🚀 OpenAI Proxy running on http://localhost:8080');
  console.log('📊 Metrics available at http://localhost:8080/metrics');
  console.log('❤️ Health check at http://localhost:8080/health');
  console.log('🎛️ Rate limiting: 800 req/min global, 60 req/min per user');
  console.log('⚡ Max concurrent: 40 global, 2 per user');
});