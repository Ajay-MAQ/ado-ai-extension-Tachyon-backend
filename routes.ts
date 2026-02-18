import { Router } from "express";
import axios from "axios";
import { authMiddleware } from "./middleware";
import { generate } from "./openai";

const router = Router();

/* ===============================
   TYPES
================================ */

interface CreateTaskInput {
  title: string;
  description: string;
}

interface AdoWorkItemResponse {
  id: number;
}

interface AITestStep {
  action: string;
  expected: string;
}

interface AITestCase {
  title: string;
  steps: AITestStep[];
}

interface AdoFeatureResponse {
  relations?: Array<{ rel: string; url: string }>;
}

router.get("/feature-stories/:org/:project/:featureId", authMiddleware, async (req, res) => {
  try {
    const { org, project, featureId } = req.params;

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const accessToken = authHeader.replace("Bearer ", "");

    // 1️⃣ Get Feature with relations
    const featureResponse = await axios.get<AdoFeatureResponse>(
      `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${featureId}?$expand=relations&api-version=7.0`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const relations = featureResponse.data.relations || [];

    // 2️⃣ Extract User Story IDs
    const storyIds = relations
      .filter((rel: any) => rel.rel === "System.LinkTypes.Hierarchy-Forward")
      .map((rel: any) => rel.url.split("/").pop());

    if (!storyIds.length) {
      return res.json({ stories: [] });
    }

    // 3️⃣ Batch fetch stories
    const storiesResponse = await axios.post<{ value: any[] }>(
      `https://dev.azure.com/${org}/${project}/_apis/wit/workitemsbatch?api-version=7.0`,
      {
        ids: storyIds,
        fields: [
          "System.Id",
          "System.Title",
          "System.Description",
          "Microsoft.VSTS.Scheduling.StoryPoints",
          "Microsoft.VSTS.Common.Priority",
          "Microsoft.VSTS.Common.Risk"
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const stories = storiesResponse.data.value.map((wi: any) => ({
      id: wi.id,
      title: wi.fields["System.Title"],
      description: wi.fields["System.Description"] || "",
      storyPoints: wi.fields["Microsoft.VSTS.Scheduling.StoryPoints"] || 0,
      priority: wi.fields["Microsoft.VSTS.Common.Priority"] || 2,
      risk: wi.fields["Microsoft.VSTS.Common.Risk"] || "Medium"
    }));

    console.log(`Fetched ${stories.length} stories for feature ${featureId}`);

    res.json({ stories });

  } catch (err) {
    console.error("❌ Fetch stories error:", err);
    res.status(500).json({ error: "Failed to fetch feature stories" });
  }
});







/* ===============================
   ANALYZE (LLM GENERATION)
================================ */

router.post("/analyze", authMiddleware, async (req, res) => {
  try {
    const {title, description, type, action, employees, stories} = req.body;

    if (!title || !action) {
      return res.status(400).json({ error: "Missing title or action" });
    }

    const prompt = buildPrompt(title, description, type, action, employees, stories);

    const output = await generate(prompt);

    res.json({ output });

  } catch (err) {
    console.error("❌ Analyze error:", err);
    res.status(500).json({ error: "AI failure" });
  }
});


/* ===============================
   CREATE TASKS UNDER USER STORY
================================ */

router.post("/create-tasks", authMiddleware, async (req, res) => {
  try {
    const { org, project, userStoryId, tasks } = req.body;
    console.log("Create tasks request received with payload:", req.body);

    if (!org || !project || !userStoryId || !Array.isArray(tasks)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    // const pat = process.env.ADO_PAT;
    // console.log("Using ADO_PAT:", !!pat);
    // if (!pat) {
    //   return res.status(500).json({ error: "ADO_PAT not configured" });
    // }

    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const accessToken = authHeader.replace("Bearer ", "");


    // const auth = Buffer.from(":" + pat).toString("base64");
    const createdTasks: number[] = [];

    for (const task of tasks as CreateTaskInput[]) {
      const response = await axios.post<AdoWorkItemResponse>(
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
            Authorization: `Bearer ${accessToken}`
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
    console.error("Create tasks error:", err);
    res.status(500).json({ error: "Task creation failed" });
  }
});



router.post("/create-testcases", authMiddleware, async (req, res) => {
  try {
    const { org, project, userStoryId, testCases } = req.body;

    if (!org || !project || !userStoryId || !Array.isArray(testCases)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const accessToken = authHeader.replace("Bearer ", "");

    const createdTestCases: number[] = [];

    for (const testCase of testCases as AITestCase[]) {

      // Convert steps to ADO XML format
      const stepsXml =
        `<steps id="0">` +
        testCase.steps
          .map(
            (s, i) => `
            <step id="${i + 1}" type="ActionStep">
              <parameterizedString isformatted="true">${s.action}</parameterizedString>
              <parameterizedString isformatted="true">${s.expected}</parameterizedString>
            </step>`
          )
          .join("") +
        `</steps>`;

      const response = await axios.patch<{ id: number }>(
        `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$Test%20Case?api-version=7.0`,
        [
          {
            op: "add",
            path: "/fields/System.Title",
            value: testCase.title
          },
          {
            op: "add",
            path: "/fields/Microsoft.VSTS.TCM.Steps",
            value: stepsXml
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
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      createdTestCases.push(response.data.id);
    }

    res.json({ success: true, createdTestCases });

  } catch (err) {
    console.error("Create test cases error:", err);
    res.status(500).json({ error: "Test case creation failed" });
  }
});



router.post("/create-stories", authMiddleware, async (req, res) => {
  try {
    const { org, project, featureId, stories } = req.body;

    if (!org || !project || !featureId || !Array.isArray(stories)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const accessToken = authHeader.replace("Bearer ", "");


    const createdStories: number[] = [];

    for (const story of stories) {
      const operations: any[] = [
        { op: "add", path: "/fields/System.Title", value: story.title },
        { op: "add", path: "/fields/System.Description", value: story.description },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: story.storyPoints },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: story.priority },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Risk", value: story.risk },
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: `https://dev.azure.com/${org}/${project}/_apis/wit/workItems/${featureId}`
          }
        }
      ];

      // ✅ Dependency → Discussion tab
      if (story.dependency) {
        operations.push({
          op: "add",
          path: "/fields/System.History",
          value: `Dependency: ${story.dependency}`
        });
      }

      const response = await axios.post<AdoWorkItemResponse>(
        `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$User%20Story?api-version=7.0`,
        operations,
        {
          headers: {
            "Content-Type": "application/json-patch+json",
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      createdStories.push(response.data.id);
    }

    res.json({ success: true, createdStories });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Story creation failed" });
  }
});


/* ===============================
   PROMPT BUILDER
================================ */

function buildPrompt(
  title: string,
  desc: string,
  type: string,
  action: string,
  employees?: number,
  stories?: any[]
) {
  switch (action) {


    case "sprintplan":
          return `
    You are an Agile Sprint Planning Assistant.

    Inputs:
    - Sprint = 10 working days
    - 1 day = 8 hours
    - 1 Story Point = 8 hours
    - Capacity per employee per sprint = 10 Story Points

    Employees: ${employees}

    User Stories:
    ${JSON.stringify(stories, null, 2)}

    Rules:
    - Plan for 3 sprints:
      Sprint N, Sprint N+1, Sprint N+2
    - Respect priority & dependency
    - If story doesn't fully fit:
      SPLIT story points across sprints
    - Carry forward remaining points
    - Keep realistic workload

    Return ONLY valid JSON:

    {
      "sprintPlan": {
        "Sprint N": [],
        "Sprint N+1": [],
        "Sprint N+2": []
      },
      "summary": {
        "capacityPerSprint": number,
        "totalStoryPoints": number
      }
    }
    `;



    case "stories":
      return `
    You are a Senior Product Owner.

    Generate Agile User Stories for the following Feature.

    Rules:
    - Follow Agile best practices (INVEST)
    - Stories should be as independent as possible
    - Minimize dependencies unless unavoidable
    - Each story must be <= 10 story points
    - 1 Story Point = 8 hours
    - Estimate story points relatively
    - Assign:
      - storyPoints (number, max 10)
      - rank (execution order)
      - priority = Based on rank + dependency + business value ("type": "integer", "description": "Business importance. 1=must fix; 4=unimportant." and range 1-4)
      - risk ( "type": "string", "description": "Uncertainty in epic" Accepts only : "1 - High", "2 - Medium", "3 - Low")

    Return ONLY valid JSON.

    JSON format:
    {
      "userStories": [
        {
          "title": "",
          "description": "",
          "storyPoints": 3,
          "rank": 1,
          "priority": 1,
          "risk": 2,
          "dependency": ""
        }
      ]
    }

    Feature Title:
    ${title}

    Feature Description:
    ${desc}
    `;



      case "tasks":
        return `
      You are a Senior Azure DevOps Engineer.

      Break the following User Story into implementation tasks.

      Rules:
      - Consider story complexity
      - Ensure tasks align with estimated Story Points
      - Avoid over-fragmentation
      - Return ONLY valid JSON

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



      case "testcases":
        return `
      You are a Senior QA Engineer.

      Generate Azure DevOps Test Cases for the following User Story.

      Rules:
      - Return ONLY valid JSON
      - No markdown
      - No explanations

      JSON format:
      {
        "testCases": [
          {
            "title": "",
            "steps": [
              {
                "action": "",
                "expected": ""
              }
            ]
          }
        ]
      }

      User Story Title:
      ${title}

      User Story Description:
      ${desc}
      `;


    case "description":
      return `Write a clear, professional Azure DevOps description only for the following ${type}: ${title}. Directly give descriptiion no need of heading`;

    case "criteria":
      return `Generate professional acceptance criteria only for the following User Story: ${title}. Directly give Acceptance criteria without heading in point vice fashion such that when I insert into azure ado acceptance criteria it should visible in the point vice fashion`;

    case "tests":
      return `You are a Senior QA Engineer. Create test cases for: ${title}`;

    case "bug":
      return `Summarize this bug clearly and professionally: ${desc}`;

    default:
      return title;
  }
}

export default router;
