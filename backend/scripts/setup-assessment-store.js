import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "team_12.env") });

import { assessmentStoreConfiguration, ensureAssessmentStore } from "../src/assessment-store.js";

const created = await ensureAssessmentStore();
const config = assessmentStoreConfiguration();
console.log(
  created
    ? `Created ${config.writeSchema}.RISK_ASSESSMENTS (source data remains in ${config.sourceSchema}).`
    : `${config.writeSchema}.RISK_ASSESSMENTS already exists.`,
);
