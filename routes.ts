import { Router } from "express";
import { authMiddleware } from "./middleware";
import { generate } from "./openai";
import axios from "axios";

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




router.post("/create-tasks", authMiddleware, async (req, res) => {
  try {
    const {
      org,
      project,
      userStoryId,
      tasks
    } = req.body;

    if (!org || !project || !userStoryId || !tasks?.length) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const pat = process.env.ADO_PAT!;
    const auth = Buffer.from(":" + pat).toString("base64");

    const createdTasks = [];

    for (const task of tasks) {
      const response = await axios.post(
        `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$Task?api-version=7.0`,
        [
          {
            op: "add",
            path: "/fields/System.Title",
            value: task.title
          },
          {
            op: "add",
            path: "/fields/System.Description",
            value: task.description
          },
          {
            op: "add",
            path: "/relations/-",
            value: {
              rel: "System.LinkTypes.Hierarchy-Reverse",
              url: `https://dev.azure.com/${org}/${project}/_apis/wit/workItems/${userStoryId}`
            }
          }
        ],
        {
          headers: {
            "Content-Type": "application/json-patch+json",
            Authorization: `Basic ${auth}`
          }
        }
      );

      createdTasks.push(response.data.id);
    }

    res.json({
      success: true,
      createdTasks
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Task creation failed" });
  }
});




function buildPrompt(
  title: string,
  desc: string,
  type: string,
  action: string
) {
  switch (action) {

    case "tasks":
        return `
      You are a Senior Azure DevOps Engineer.

      Break the following User Story into implementation tasks.

      Rules:
      - Return ONLY valid JSON
      - No markdown
      - No explanations

      JSON format:
      {
        "tasks": [
          {
            "title": "",
            "description": ""
          }
        ]
      }

      User Story Title:
      ${title}

      User Story Description:
      ${desc}
      `;


    case "description":
      return `Write a clear, professional, and concise Azure DevOps description only for the following ${type}: ${title}.`;

    case "criteria":
      return `Generate a clear, professional, and concise Azure DevOps acceptance criteria only for: ${title}.`;

    case "tests":
      return `You are a Senior QA Engineer. Create comprehensive test cases for the : ${title}`;

    case "bug":
      return `Summarize bug report: ${desc}`;

    default:
      return title;
  }
}

export default router;
