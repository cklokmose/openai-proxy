import https from 'https';
import { promisify } from 'util';

/**
 * HTTP Transport Interface
 * Abstract interface for making HTTP requests - can be mocked for testing
 */
class HttpTransport {
  async executeRequest(options, data) {
    throw new Error('executeRequest must be implemented by subclass');
  }
}

/**
 * Real HTTP Transport - makes actual HTTPS requests to OpenAI
 */
class RealHttpTransport extends HttpTransport {
  async executeRequest(options, data) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            data: buffer,
            text: buffer.toString(),
            json: () => {
              try {
                return JSON.parse(buffer.toString());
              } catch (e) {
                throw new Error('Response is not valid JSON');
              }
            }
          });
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        const timeoutError = new Error('Request timeout');
        timeoutError.code = 'TIMEOUT';
        reject(timeoutError);
      });

      // Send data if provided
      if (data) {
        if (Buffer.isBuffer(data)) {
          req.write(data);
        } else if (typeof data === 'string') {
          req.write(data);
        } else {
          req.write(JSON.stringify(data));
        }
      }

      req.end();
    });
  }
}

/**
 * HTTP Client Service for OpenAI API
 * 
 * This service abstracts HTTP requests to OpenAI and handles retry logic, backoff, 
 * idempotency, and error handling. Uses dependency injection for the transport layer.
 */
class OpenAIHttpClient {
  constructor(config = {}) {
    this.host = config.host || 'api.openai.com';
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 120000;
    this.retryConfig = {
      maxRetries: config.maxRetries || 3,
      baseDelay: config.baseDelay || 1000,
      maxDelay: config.maxDelay || 30000,
      retryOn: config.retryOn || [429, 500, 502, 503, 504]
    };
    this.enableIdempotency = config.enableIdempotency !== false;
    
    // Dependency injection: use provided transport or default to real HTTP
    this.transport = config.transport || new RealHttpTransport();
  }

  /**
   * Set the HTTP transport (for testing)
   */
  setTransport(transport) {
    this.transport = transport;
  }

  /**
   * Make an HTTP request with retry logic and backoff
   */
  async makeRequest(options, data = null) {
    const requestOptions = {
      hostname: this.host,
      path: options.path,
      method: options.method || 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        ...options.headers
      },
      timeout: options.timeout || this.timeout,
      family: 4 // Force IPv4
    };

    // Add idempotency key for retryable requests
    if (this.enableIdempotency && ['POST', 'PUT', 'PATCH'].includes(requestOptions.method)) {
      if (!requestOptions.headers['Idempotency-Key']) {
        requestOptions.headers['Idempotency-Key'] = this.generateIdempotencyKey();
      }
    }

    let lastError;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        // Use the injected transport to make the actual request
        const result = await this.transport.executeRequest(requestOptions, data);
        
        // Success or non-retryable error
        if (!this.shouldRetry(result.statusCode, attempt)) {
          return result;
        }
        
        // Prepare for retry
        lastError = new Error(`HTTP ${result.statusCode}: ${result.statusText}`);
        lastError.statusCode = result.statusCode;
        lastError.response = result;
        
      } catch (error) {
        lastError = error;
        
        // Don't retry on non-retryable errors
        if (!this.shouldRetryError(error, attempt)) {
          throw error;
        }
      }

      // Calculate delay for next attempt
      if (attempt < this.retryConfig.maxRetries) {
        const delay = this.calculateRetryDelay(attempt, lastError);
        console.log(`[HTTP] Retrying request in ${delay}ms (attempt ${attempt + 1}/${this.retryConfig.maxRetries})`);
        await this.sleep(delay);
      }
    }

    // All retries exhausted
    throw lastError;
  }

  /**
   * Determine if we should retry based on status code and attempt number
   */
  shouldRetry(statusCode, attempt) {
    return attempt < this.retryConfig.maxRetries && 
           this.retryConfig.retryOn.includes(statusCode);
  }

  /**
   * Determine if we should retry based on error type and attempt number
   */
  shouldRetryError(error, attempt) {
    if (attempt >= this.retryConfig.maxRetries) {
      return false;
    }

    // Retry on network errors, timeouts, etc. but NOT on DNS resolution failures
    const retryableErrorCodes = ['ECONNRESET', 'ECONNREFUSED', 'TIMEOUT'];
    return retryableErrorCodes.includes(error.code);
  }

  /**
   * Calculate delay for retry with exponential backoff
   */
  calculateRetryDelay(attempt, lastError) {
    // Check for Retry-After header first
    if (lastError?.response?.headers?.['retry-after']) {
      const retryAfter = parseInt(lastError.response.headers['retry-after'], 10);
      if (!isNaN(retryAfter)) {
        return Math.min(retryAfter * 1000, this.retryConfig.maxDelay);
      }
    }

    // Exponential backoff: baseDelay * 2^attempt + jitter
    const exponentialDelay = this.retryConfig.baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    const delay = exponentialDelay + jitter;

    return Math.min(delay, this.retryConfig.maxDelay);
  }

  /**
   * Generate a unique idempotency key
   */
  generateIdempotencyKey() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Make a JSON request to OpenAI
   */
  async makeJsonRequest(path, data, options = {}) {
    const method = options.method || 'POST';
    const requestOptions = {
      path,
      method,
      headers: {
        ...options.headers
      },
      ...options
    };

    // Only add Content-Type and Content-Length for requests with body
    let requestData = null;
    if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
      requestData = JSON.stringify(data);
      requestOptions.headers['Content-Type'] = 'application/json';
      requestOptions.headers['Content-Length'] = Buffer.byteLength(requestData);
    }

    const response = await this.makeRequest(requestOptions, requestData);
    
    if (response.statusCode >= 400) {
      const error = new Error(`HTTP ${response.statusCode}: ${response.statusText}`);
      error.statusCode = response.statusCode;
      error.response = response;
      try {
        error.details = response.json();
      } catch (e) {
        error.details = { message: response.text };
      }
      throw error;
    }

    return response;
  }

  /**
   * Make a streaming request to OpenAI
   * Returns the raw response object for streaming
   */
  async makeStreamingRequest(path, data, options = {}) {
    const requestOptions = {
      hostname: this.host,
      path: path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(data)),
        ...options.headers
      },
      timeout: options.timeout || this.timeout,
      family: 4 // Force IPv4
    };

    // Add idempotency key for retryable requests
    if (this.enableIdempotency && ['POST', 'PUT', 'PATCH'].includes(requestOptions.method)) {
      if (!requestOptions.headers['Idempotency-Key']) {
        requestOptions.headers['Idempotency-Key'] = this.generateIdempotencyKey();
      }
    }

    return new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        // For streaming, we immediately resolve with the response object
        // Don't buffer the response
        resolve({
          statusCode: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          stream: res // Return the raw stream
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        const timeoutError = new Error('Request timeout');
        timeoutError.code = 'TIMEOUT';
        reject(timeoutError);
      });

      // Send data
      req.write(JSON.stringify(data));
      req.end();
    });
  }

  /**
   * Make a multipart request to OpenAI
   */
  async makeMultipartRequest(path, bodyBuffer, boundary, options = {}) {
    const requestOptions = {
      path,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(bodyBuffer),
        ...options.headers
      },
      timeout: options.timeout || 30000, // Shorter timeout for audio
      ...options
    };

    const response = await this.makeRequest(requestOptions, bodyBuffer);
    
    if (response.statusCode >= 400) {
      const error = new Error(`HTTP ${response.statusCode}: ${response.statusText}`);
      error.statusCode = response.statusCode;
      error.response = response;
      try {
        error.details = response.json();
      } catch (e) {
        error.details = { message: response.text };
      }
      throw error;
    }

    return response;
  }
}

export { OpenAIHttpClient, HttpTransport, RealHttpTransport };
