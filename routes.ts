import { Router } from "express";
import { authMiddleware } from "./middleware";
import { generate } from "./openai";

const router = Router();

router.post("/analyze", authMiddleware, async (req, res) => {
  try {
    const { title, description, type, action } = req.body;

    if (!title || !action) {
      return res.status(400).json({ error: "Invalid input" });
    }

    console.log("Received request:", { title, type, action });

    const prompt = buildPrompt(
      title,
      description,
      type,
      action
    );

    console.log("Generated prompt:", prompt);

    const output = await generate(prompt);

    res.json({ output });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI failure" });
  }
});

function buildPrompt(
  title: string,
  desc: string,
  type: string,
  action: string
) {
  switch (action) {

    case "description":
      return `Write a detailed description for ${type}: ${title}`;

    case "criteria":
      return `Generate acceptance criteria for: ${title}`;

    case "tests":
      return `Create test cases for: ${title}`;

    case "bug":
      return `Summarize bug report: ${desc}`;

    default:
      return title;
  }
}

export default router;
