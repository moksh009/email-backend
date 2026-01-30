// Native fetch is available in Node 18+
// const fetch = require('node-fetch'); 

/**
 * GlockApps Service Adapter
 * 
 * This service handles communication with the GlockApps API for:
 * 1. Creating new spam tests (getting seed lists)
 * 2. Retrieving test results
 */

class GlockAppsService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.glockapps.com/v2';
  }

  /**
   * Create a new spam test to get the seed list
   * @returns {Promise<{ testId: string, seedList: string[] }>}
   */
  async createTest() {
    if (!this.apiKey) {
      throw new Error('GlockApps API Key is required');
    }

    try {
      // Documentation: POST /v2/spam_tests
      const response = await fetch(`${this.baseUrl}/spam_tests`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // Default settings for a quick test
          note: 'Automated Test from Email Automation System'
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create GlockApps test');
      }

      const data = await response.json();
      // Parse response to get seed list
      // Note: Actual API response structure may vary, this is based on standard patterns
      return {
        testId: data.test_id,
        seedList: data.seed_list // Array of email addresses
      };
    } catch (error) {
      console.error('GlockApps Create Test Error:', error);
      // Fallback for demo/dev without key
      if (process.env.NODE_ENV === 'development' && !this.apiKey) {
         return this.getMockSeedData();
      }
      throw error;
    }
  }

  /**
   * Get results for a specific test
   * @param {string} testId 
   */
  async getTestResults(testId) {
    if (!this.apiKey) {
        throw new Error('GlockApps API Key is required');
    }

    try {
      const response = await fetch(`${this.baseUrl}/spam_tests/${testId}`, {
        headers: {
            'Authorization': `Bearer ${this.apiKey}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch test results');
      }

      const data = await response.json();
      return this.normalizeResults(data);
    } catch (error) {
       console.error('GlockApps Get Results Error:', error);
       throw error;
    }
  }

  /**
   * Normalize external API data into our internal format
   */
  normalizeResults(apiData) {
    // Map GlockApps specific fields to our generic structure
    return {
        id: apiData.test_id,
        status: apiData.status, // 'running', 'finished'
        placement: {
            inbox: apiData.inbox_rate || 0,
            spam: apiData.spam_rate || 0,
            missing: apiData.missing_rate || 0
        },
        breakdown: apiData.providers?.map(p => ({
            name: p.name, // Gmail, Outlook, etc.
            inbox: p.inbox_rate,
            spam: p.spam_rate
        })) || []
    };
  }

  getMockSeedData() {
      // Returns a mock structure for UI testing when no API key is present
      return {
          testId: 'mock-test-' + Date.now(),
          seedList: [
              'seed-1@glockapps.com',
              'seed-2@glockapps.com',
              'seed-gmail-test@gmail.com',
              'seed-outlook-test@outlook.com'
          ]
      };
  }
}

module.exports = GlockAppsService;
