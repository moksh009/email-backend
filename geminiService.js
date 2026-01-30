const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const generateEmail = async (prompt) => {
  try {
    // valid models: gemini-2.0-flash, gemini-1.5-flash, gemini-pro-latest
    // Using gemini-2.5-flash-lite as it is the only one with remaining quota
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    
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
    console.error("Gemini API Error:", error);
    // Throw the original error message to the client for better debugging
    throw new Error(`Gemini API Failed: ${error.message || error}`);
  }
};

module.exports = {
  generateEmail
};
