
const Groq = require('groq-sdk');
require('dotenv').config();

let groq = null;
if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

const generateEmail = async (prompt) => {
  if (!groq) {
    throw new Error("GROQ_API_KEY is missing in .env");
  }

  try {
    // Llama 3 70b is equivalent to GPT-4/Gemini Pro
    // Llama 3 8b is faster/cheaper (equivalent to Flash)
    // using 70b for quality since it is free
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" } // Force JSON
    });

    const content = completion.choices[0]?.message?.content || "{}";
    
    try {
      return JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse Groq JSON:", content);
      return {
        subject: "Quick Question",
        content: content
      };
    }
  } catch (error) {
    console.error("Groq API Error:", error);
    throw new Error(`Groq API Failed: ${error.message || error}`);
  }
};

module.exports = {
  generateEmail
};
