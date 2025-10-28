import fs from 'fs';

// Load configuration
let config = {};
try {
  const configData = fs.readFileSync('./config.json', 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.warn('Could not load config.json for allowlist configuration:', error.message);
  config = {};
}

// Default allowlist configuration
const defaultAllowlistConfig = {
  enabled: true,
  endpoints: [
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings', 
    '/v1/audio/speech',
    '/v1/audio/transcriptions'
  ],
  models: [
    'gpt-4o-mini',
    'text-embedding-3-small'
  ],
  default_model: 'gpt-4o-mini'
};

const allowlistConfig = config.ALLOWLIST || defaultAllowlistConfig;

/**
 * Check if allowlist is enabled
 */
export function isAllowlistEnabled() {
  return allowlistConfig.enabled !== false;
}

/**
 * Check if an endpoint is allowed
 */
export function isEndpointAllowed(endpoint) {
  if (!isAllowlistEnabled()) {
    return true; // Allow all if disabled
  }
  
  // Normalize the endpoint - remove query parameters and ensure it starts with /v1
  let normalizedEndpoint = endpoint.split('?')[0];
  if (!normalizedEndpoint.startsWith('/v1/')) {
    normalizedEndpoint = '/v1' + normalizedEndpoint;
  }
  
  // Check for exact match or prefix match (for endpoints with path parameters)
  return allowlistConfig.endpoints.some(allowedEndpoint => {
    // Exact match
    if (normalizedEndpoint === allowedEndpoint) {
      return true;
    }
    // Prefix match - check if the endpoint starts with the allowed endpoint followed by /
    // This allows /v1/responses to match /v1/responses/{id}
    if (normalizedEndpoint.startsWith(allowedEndpoint + '/')) {
      return true;
    }
    return false;
  });
}

/**
 * Check if a model is allowed
 */
export function isModelAllowed(model) {
  if (!isAllowlistEnabled()) {
    return true; // Allow all if disabled
  }
  
  if (!model) {
    return true; // Will be replaced with default model
  }
  
  return allowlistConfig.models.includes(model);
}

/**
 * Get the default model to use when none is specified or when an invalid model is used
 */
export function getDefaultModel() {
  return allowlistConfig.default_model;
}

/**
 * Validate and potentially modify a request body based on allowlist rules
 */
export function validateAndNormalizeRequest(requestBody, endpoint) {
  if (!isAllowlistEnabled()) {
    return { valid: true, body: requestBody };
  }
  
  // Clone the request body to avoid modifying the original
  const normalizedBody = { ...requestBody };
  
  // Check model if specified
  if (normalizedBody.model) {
    if (!isModelAllowed(normalizedBody.model)) {
      return { 
        valid: false, 
        error: `Model '${normalizedBody.model}' is not allowed`,
        details: { 
          model: normalizedBody.model,
          allowed_models: config.ALLOWLIST.models 
        }
      };
    }
  } else {
    // Set default model if none specified
    normalizedBody.model = getDefaultModel();
    console.log(`📝 No model specified, using default: ${normalizedBody.model}`);
  }
  
  return { valid: true, body: normalizedBody };
}

/**
 * Get current allowlist configuration for monitoring/debugging
 */
export function getAllowlistConfig() {
  return allowlistConfig;
}

/**
 * Get allowlist status for health checks
 */
export function getAllowlistStatus() {
  return {
    enabled: isAllowlistEnabled(),
    allowed_endpoints: allowlistConfig.endpoints.length,
    allowed_models: allowlistConfig.models.length,
    default_model: allowlistConfig.default_model,
    endpoints: allowlistConfig.endpoints,
    models: allowlistConfig.models
  };
}

export { allowlistConfig };
