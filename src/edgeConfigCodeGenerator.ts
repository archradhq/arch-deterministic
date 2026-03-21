/**
 * Edge Configuration Code Generator Utilities
 * Provides utilities for code generators to use edge/connectivity configurations
 */

export interface EdgeConfig {
  edgeType?: string;
  protocol?: string;
  transport?: 'sync' | 'async' | 'streaming';
  config?: {
    timeout?: number;
    retry?: {
      maxAttempts?: number;
      strategy?: 'exponential' | 'linear' | 'fixed';
      backoffMs?: number;
    };
    circuitBreaker?: {
      enabled?: boolean;
      failureThreshold?: number;
      resetTimeoutMs?: number;
    };
    authentication?: {
      type?: string;
      credentialRef?: {
        vault?: string;
        key?: string;
      };
    };
    loadBalancing?: {
      strategy?: string;
      endpoints?: string[];
    };
    [key: string]: any;
  };
}

/**
 * Generate retry logic code from edge configuration
 */
export function generateRetryCode(edgeConfig: EdgeConfig, language: 'python' | 'nodejs' | 'java' | 'csharp' | 'go'): string {
  const retry = edgeConfig.config?.retry;
  if (!retry || !retry.maxAttempts || retry.maxAttempts <= 0) {
    return '';
  }

  const maxAttempts = retry.maxAttempts;
  const strategy = retry.strategy || 'exponential';
  const backoffMs = retry.backoffMs || 1000;

  switch (language) {
    case 'python':
      if (strategy === 'exponential') {
        return `
import time
import random

def retry_with_exponential_backoff(func, max_attempts=${maxAttempts}, base_delay=${backoffMs / 1000}):
    """Retry function with exponential backoff"""
    for attempt in range(max_attempts):
        try:
            return func()
        except Exception as e:
            if attempt == max_attempts - 1:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 0.1)
            time.sleep(delay)
    raise Exception("Max retry attempts exceeded")
`;
      } else {
        return `
import time

def retry_with_linear_backoff(func, max_attempts=${maxAttempts}, delay=${backoffMs / 1000}):
    """Retry function with linear backoff"""
    for attempt in range(max_attempts):
        try:
            return func()
        except Exception as e:
            if attempt == max_attempts - 1:
                raise
            time.sleep(delay)
    raise Exception("Max retry attempts exceeded")
`;
      }

    case 'nodejs':
      if (strategy === 'exponential') {
        return `
const retryWithExponentialBackoff = async (fn, maxAttempts = ${maxAttempts}, baseDelay = ${backoffMs}) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};
`;
      } else {
        return `
const retryWithLinearBackoff = async (fn, maxAttempts = ${maxAttempts}, delay = ${backoffMs}) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};
`;
      }

    default:
      return `// Retry logic: ${maxAttempts} attempts, ${strategy} backoff, ${backoffMs}ms base delay`;
  }
}

/**
 * Generate circuit breaker code from edge configuration
 */
export function generateCircuitBreakerCode(edgeConfig: EdgeConfig, language: 'python' | 'nodejs' | 'java' | 'csharp' | 'go'): string {
  const circuitBreaker = edgeConfig.config?.circuitBreaker;
  if (!circuitBreaker?.enabled) {
    return '';
  }

  const failureThreshold = circuitBreaker.failureThreshold || 5;
  const resetTimeoutMs = circuitBreaker.resetTimeoutMs || 60000;

  switch (language) {
    case 'python':
      return `
from datetime import datetime, timedelta

class CircuitBreaker:
    def __init__(self, failure_threshold=${failureThreshold}, reset_timeout=${resetTimeoutMs / 1000}):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.failure_count = 0
        self.last_failure_time = None
        self.state = 'CLOSED'  # CLOSED, OPEN, HALF_OPEN
    
    def call(self, func):
        if self.state == 'OPEN':
            if datetime.now() - self.last_failure_time > timedelta(seconds=self.reset_timeout):
                self.state = 'HALF_OPEN'
            else:
                raise Exception("Circuit breaker is OPEN")
        
        try:
            result = func()
            if self.state == 'HALF_OPEN':
                self.state = 'CLOSED'
                self.failure_count = 0
            return result
        except Exception as e:
            self.failure_count += 1
            self.last_failure_time = datetime.now()
            if self.failure_count >= self.failure_threshold:
                self.state = 'OPEN'
            raise
`;
    case 'nodejs':
      return `
class CircuitBreaker {
  constructor(failureThreshold = ${failureThreshold}, resetTimeout = ${resetTimeoutMs}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
  }
  
  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
      }
      throw error;
    }
  }
}
`;
    default:
      return `// Circuit breaker: ${failureThreshold} failures, ${resetTimeoutMs}ms reset timeout`;
  }
}

/**
 * Generate HTTP client code with edge configuration
 */
export function generateHttpClientCode(
  edgeConfig: EdgeConfig,
  url: string,
  method: string,
  language: 'python' | 'nodejs' | 'java' | 'csharp' | 'go'
): string {
  const protocol = edgeConfig.protocol || 'https';
  const timeout = edgeConfig.config?.timeout || 30000;
  const hasRetry = edgeConfig.config?.retry?.maxAttempts && edgeConfig.config.retry.maxAttempts > 0;
  const hasCircuitBreaker = edgeConfig.config?.circuitBreaker?.enabled;

  switch (language) {
    case 'python':
      const retryCode = hasRetry ? generateRetryCode(edgeConfig, 'python') : '';
      const cbCode = hasCircuitBreaker ? generateCircuitBreakerCode(edgeConfig, 'python') : '';
      
      return `
import requests
${retryCode}
${cbCode}

def make_request():
    response = requests.${method.toLowerCase()}(
        '${protocol}://${url}',
        timeout=${timeout / 1000}
    )
    response.raise_for_status()
    return response.json()

${hasRetry ? 'result = retry_with_exponential_backoff(make_request)' : 'result = make_request()'}
`;
    case 'nodejs':
      const retryCodeJs = hasRetry ? generateRetryCode(edgeConfig, 'nodejs') : '';
      const cbCodeJs = hasCircuitBreaker ? generateCircuitBreakerCode(edgeConfig, 'nodejs') : '';
      
      return `
const axios = require('axios');
${retryCodeJs}
${cbCodeJs}

const makeRequest = async () => {
  const response = await axios.${method.toLowerCase()}({
    url: '${protocol}://${url}',
    timeout: ${timeout}
  });
  return response.data;
};

${hasRetry ? 'const result = await retryWithExponentialBackoff(makeRequest);' : 'const result = await makeRequest();'}
`;
    default:
      return `// HTTP ${method} request to ${protocol}://${url} with ${timeout}ms timeout`;
  }
}

/**
 * Get edge configuration for a specific edge
 */
export function getEdgeConfig(edges: any[], fromNodeId: string, toNodeId: string): EdgeConfig | null {
  const edge = edges.find(
    (e) => (e.from === fromNodeId || e.source === fromNodeId) && (e.to === toNodeId || e.target === toNodeId)
  );
  
  if (!edge) return null;

  return {
    edgeType: edge.edgeType || edge.type,
    protocol: edge.protocol,
    transport: edge.transport,
    config: edge.config,
  };
}

/**
 * Apply edge configuration to code generation context
 */
export function applyEdgeConfigToContext(
  edges: any[],
  fromNodeId: string,
  toNodeId: string,
  context: Record<string, any>
): void {
  const edgeConfig = getEdgeConfig(edges, fromNodeId, toNodeId);
  
  if (edgeConfig) {
    context.edgeType = edgeConfig.edgeType;
    context.protocol = edgeConfig.protocol;
    context.transport = edgeConfig.transport;
    context.timeout = edgeConfig.config?.timeout;
    context.hasRetry = !!(edgeConfig.config?.retry?.maxAttempts && edgeConfig.config.retry.maxAttempts > 0);
    context.hasCircuitBreaker = edgeConfig.config?.circuitBreaker?.enabled;
    context.retryConfig = edgeConfig.config?.retry;
    context.circuitBreakerConfig = edgeConfig.config?.circuitBreaker;
  }
}

