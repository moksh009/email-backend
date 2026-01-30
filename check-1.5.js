
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const apiKey = process.env.GEMINI_API_KEY;

async function test() {
  try {
    console.log("🔄 Listing models...");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();
    
    if (data.models) {
      const onePointFive = data.models.filter(m => m.name.includes('1.5'));
      console.log("Found 1.5 models:", onePointFive.map(m => m.name));
      
      const flash = data.models.filter(m => m.name.toLowerCase().includes('flash'));
      console.log("All Flash models:", flash.map(m => m.name));
    }
  } catch (e) {
    console.log("Error:", e.message);
  }
}

test();
