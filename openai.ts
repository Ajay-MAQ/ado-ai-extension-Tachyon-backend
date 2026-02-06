import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const client = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: process.env.AZURE_OPENAI_ENDPOINT,
  defaultQuery: { "api-version": "2024-02-15-preview" },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY }
});

export async function generate(prompt: string) {
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!deployment) {
    throw new Error(
      "Missing Azure OpenAI deployment name. Set AZURE_OPENAI_DEPLOYMENT_NAME."
    );
  }

  try {
    const completion = await client.chat.completions.create({
      model: deployment,
      messages: [
        { role: "system", content: "You are a software assistant" },
        { role: "user", content: prompt }
      ]
    });

    // Prefer the standard message content where available
    const message = completion.choices?.[0]?.message?.content;
    if (typeof message === "string") return message;

    return "";
  } catch (err) {
    console.error("Azure OpenAI generate error:", err);
    throw err;
  }
}
