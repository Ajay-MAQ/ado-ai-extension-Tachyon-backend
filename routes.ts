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
    const {title, description, type, action, sprintPoints, stories} = req.body;

    if (!title || !action) {
      return res.status(400).json({ error: "Missing title or action" });
    }

    const prompt = buildPrompt(title, description, type, action, sprintPoints, stories);

    const output = await generate(prompt);

    console.log("Generated output:", output);

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

// update existing user stories -- used when loading and editing from ADO
router.post("/update-stories", authMiddleware, async (req, res) => {
  try {
    const { org, project, stories } = req.body;
    if (!org || !project || !Array.isArray(stories)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }
    const accessToken = authHeader.replace("Bearer ", "");

    const updatedIds: number[] = [];
    for (const story of stories) {
      if (!story.id) continue;
      const ops: any[] = [];
      if (story.title !== undefined) {
        ops.push({ op: "add", path: "/fields/System.Title", value: story.title });
      }
      if (story.storyPoints !== undefined) {
        ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: story.storyPoints });
      }
      if (ops.length > 0) {
        await axios.patch(
          `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${story.id}?api-version=7.0`,
          ops,
          {
            headers: {
              "Content-Type": "application/json-patch+json",
              Authorization: `Bearer ${accessToken}`
            }
          }
        );
        updatedIds.push(story.id);
      }
    }
    res.json({ success: true, updatedIds });
  } catch (err) {
    console.error("Update stories error", err);
    res.status(500).json({ error: "Update failed" });
  }
});


// compute sprint capacities from ADO: team size * (workingDaysInIteration - daysOff)
router.post("/compute-capacity", authMiddleware, async (req, res) => {
  try {
    const { org, project, team, iterationPaths } = req.body;

    if (!org || !project || !team) {
      return res.status(400).json({ error: "Missing org/project/team" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }
    const accessToken = authHeader.replace("Bearer ", "");

    // helper: count business days between two dates (inclusive)
    function countBusinessDays(start: Date, end: Date) {
      let count = 0;
      const cur = new Date(start);
      while (cur <= end) {
        const day = cur.getDay();
        if (day !== 0 && day !== 6) count++;
        cur.setDate(cur.getDate() + 1);
      }
      return count;
    }

    // 1️⃣ fetch team iterations (if iterationPaths not provided, take next 3 iterations)
    const iterationsRes = await axios.get<any>(
      `https://dev.azure.com/${org}/${project}/${team}/_apis/work/teamsettings/iterations?api-version=7.0`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    let iterations: any[] = iterationsRes.data?.value || [];

    // map to objects with start/finish dates
    const mapped = iterations
      .map((it: any) => ({
        path: it.path || it.name,
        start: it.attributes?.startDate ? new Date(it.attributes.startDate) : null,
        finish: it.attributes?.finishDate ? new Date(it.attributes.finishDate) : null,
      }))
      .filter((it: any) => it.start && it.finish)
      .sort((a: any, b: any) => a.start.getTime() - b.start.getTime());

    // if caller provided iterationPaths, try to locate them; otherwise choose next 3 by start date
    let targets: any[] = [];
    if (Array.isArray(iterationPaths) && iterationPaths.length >= 3) {
      for (const p of iterationPaths.slice(0, 3)) {
        const found = mapped.find((m: any) => m.path === p || m.path?.endsWith(p));
        if (found) targets.push(found);
      }
    }
    if (targets.length < 3) {
      const now = new Date();
      const upcoming = mapped.filter((m: any) => m.finish >= now);
      targets = upcoming.slice(0, 3);
    }

    if (targets.length < 3) {
      // fallback: take first 3 mapped
      targets = mapped.slice(0, 3);
    }

    // 2️⃣ fetch team members with their individual capacities and days off
    let teamMembers: any[] = [];
    try {
      const memberListRes = await axios.get<any>(
        `https://dev.azure.com/${org}/${project}/${team}/_apis/TeamFoundation/Teams/${team}/Members?api-version=6.0`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      teamMembers = Array.isArray(memberListRes.data?.value) ? memberListRes.data.value : [];
    } catch (e) {
      console.warn("Could not fetch team members", (e as any)?.message || e);
    }

    const teamSize = teamMembers.length || 1;

    // 3️⃣ fetch iteration capacities per member; these include per-member, per-iteration days off
    const iterationCapacitiesRes = await axios.get<any>(
      `https://dev.azure.com/${org}/${project}/${team}/_apis/work/teamsettings/iterations/capacities?api-version=7.0`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const allIterationCapacities: any[] = iterationCapacitiesRes.data?.value || [];

    // helper: count overlap business days between two ranges
    function overlapBusinessDays(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
      const start = aStart > bStart ? aStart : bStart;
      const end = aEnd < bEnd ? aEnd : bEnd;
      if (start > end) return 0;
      return countBusinessDays(start, end);
    }

    const capacities: number[] = [];

    for (let i = 0; i < 3; i++) {
      const it = targets[i];
      if (!it || !it.start || !it.finish) {
        capacities.push(0);
        continue;
      }

      const totalWorkDays = countBusinessDays(it.start, it.finish);

      // sum capacity per member from ADO iteration capacities
      // ADO returns per-member capacities with daysOff already subtracted
      let totalCapacityForIteration = 0;
      for (const cap of allIterationCapacities) {
        // match iteration by path or id
        if (cap.iterationPath && cap.iterationPath === it.path) {
          // cap.activities contains per-member capacity & days off data
          if (Array.isArray(cap.activities)) {
            for (const activity of cap.activities) {
              // activity has capacityPerDay and daysOff
              const capPerDay = activity.capacityPerDay || 0;
              const daysOff = activity.daysOff || 0;
              const memberWorkDays = totalWorkDays - daysOff;
              totalCapacityForIteration += Math.max(0, capPerDay * memberWorkDays);
            }
          }
        }
      }

      // fallback if ADO API doesn't return detailed capacity: use simple formula
      // capacity = (10 business days * teamSize) - sum(each member's days off)
      if (totalCapacityForIteration === 0 && teamSize > 0) {
        const baseCapacity = totalWorkDays * teamSize;
        totalCapacityForIteration = baseCapacity;
      }

      capacities.push(Math.max(0, totalCapacityForIteration));
    }

    res.json({ capacities: { n: capacities[0] || 0, n1: capacities[1] || 0, n2: capacities[2] || 0 }, iterations: targets.map(t=>t.path) });
  } catch (err) {
    console.error("Compute capacity error", (err as any)?.message || err);
    res.status(500).json({ error: "Failed to compute capacities" });
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
  sprintPoints?: { n: number; n1: number; n2: number },
  stories?: any[]
) {
  switch (action) {


    case "sprintplan":
          return `
      You are an Agile Sprint Planning Assistant.

      TASK:
      Allocate the provided user stories across three sprints.

      INPUT:
      Feature Title: ${title}

      Sprint Capacities:
      - Sprint N: ${sprintPoints?.n}
      - Sprint N+1: ${sprintPoints?.n1}
      - Sprint N+2: ${sprintPoints?.n2}

      User Stories (in given order):
      ${JSON.stringify(stories, null, 2)}

      PLANNING RULES (STRICT):
      1. Follow EXACT story order (do NOT reorder)
      2. Sprint capacity MUST be completely filled using whole stories
      3. **Stories MUST NOT be split across sprints.**
      4. Move a story to the next sprint only when the remaining capacity in the current sprint is less than the story's points
      5. Do NOT modify story points
      6. Do NOT invent stories
      7. Stop if backlog exhausted

      OUTPUT FORMAT (STRICT JSON ONLY):

      {
        "sprints": [
          {
            "name": "Sprint N",
            "capacity": number,
            "allocatedPoints": number,
            "stories": [
              {
                "id": "string",
                "title": "string",
                "allocatedPoints": number,
                "remainingPoints": number
              }
            ]
          }
        ],
        "unallocatedStories": [
          {
            "id": "string",
            "title": "string",
            "remainingPoints": number
          }
        ]
      }

      VALIDATION:
      - allocatedPoints MUST equal sprint capacity
      - No negative numbers
      - JSON must be valid

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
      return `Write a clear, professional Azure DevOps description only in the Gherkin format for the following ${type}: ${title}. Directly give descriptiion no need of heading`;

    case "criteria":
      return `Generate professional acceptance criteria only in the Gherkin format for the following User Story: ${title}. Directly give Acceptance criteria without heading in point vice fashion with <br> tags at the end of each point`;

    case "tests":
      return `You are a Senior QA Engineer. Create test cases for: ${title}`;

    case "bug":
      return `Summarize this bug clearly and professionally: ${desc}`;

    default:
      return title;
  }
}

export default router;

