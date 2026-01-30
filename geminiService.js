const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateEmail = async (prompt, retries = 3) => {
  try {
    // valid models: gemini-2.0-flash, gemini-1.5-flash, gemini-pro-latest
    // Using gemini-2.0-flash as it is more stable than experimental
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Attempt to parse JSON from the response
    // Gemini might wrap it in ```json ... ```
    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    try {
      return JSON.parse(cleanText);
    } catch (e) {
      console.error("Failed to parse Gemini JSON:", text);
      // Fallback if not valid JSON
      return {
        subject: "Quick Question",
        content: text
      };
    }
  } catch (error) {
    console.error(`Gemini API Error (Attempt ${4 - retries}/3):`, error.message);
    
    // Handle Rate Limiting (429) or Overloaded (503)
    if (retries > 0 && (error.message.includes('429') || error.message.includes('503') || error.message.includes('Overloaded') || error.message.includes('retryDelay'))) {
        const delay = 2000 * (4 - retries); // 2s, 4s, 6s
        console.log(`Retrying Gemini in ${delay}ms...`);
        await sleep(delay);
        return generateEmail(prompt, retries - 1);
    }

    // Throw the original error message to the client for better debugging
    throw new Error(`Gemini API Failed: ${error.message || error}`);
  }
};

module.exports = {
  generateEmail
};
