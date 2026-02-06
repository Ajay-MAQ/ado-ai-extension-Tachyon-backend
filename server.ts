// import express from "express";
// import cors from "cors";
// import routes from "./routes";
// import * as dotenv from "dotenv";

// dotenv.config();


// dotenv.config();

// const app = express();

// app.use(cors());
// // app.use(cors({
// //   origin: "https://konakalla-ado.gallerycdn.vsassets.io",
// //   // credentials: true
// // }));
// // app.use(express.json());

// app.use("/api", routes);

// const PORT = 4000;

// app.listen(PORT, () => {
//   console.log(`Backend running on ${PORT}`);
// });



import express from "express";
import cors from "cors";
import routes from "./routes";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();

/**
 * Parse JSON bodies
 */
app.use(express.json());

/**
 * CORS for Azure DevOps Extensions
 */
app.use(
  cors({
    origin: [
      "https://dev.azure.com",
      "https://*.visualstudio.com",
      "https://konakalla-ado.gallerycdn.vsassets.io"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

/**
 * Routes
 */
app.use("/api", routes);

/**
 * Render provides PORT via env
 */
const PORT = process.env.PORT || 4000;

/**
 * Bind to all interfaces (important for cloud hosting)
 */
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});
