import { assessmentStoreConfiguration, ensureAssessmentStore } from "../src/assessment-store.js";

const created = await ensureAssessmentStore();
const config = assessmentStoreConfiguration();
console.log(
  created
    ? `Created ${config.writeSchema}.RISK_ASSESSMENTS (source data remains in ${config.sourceSchema}).`
    : `${config.writeSchema}.RISK_ASSESSMENTS already exists.`,
);
