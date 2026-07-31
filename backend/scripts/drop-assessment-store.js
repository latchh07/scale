import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "team_12.env") });

import { assessmentStoreConfiguration } from "../src/assessment-store.js";
import hanaClient from "@sap/hana-client";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured for assessment persistence`);
  return value;
}

const options = {
    host: requiredEnvironment("HANA_HOST"),
    port: Number(requiredEnvironment("HANA_PORT")),
    uid: requiredEnvironment("HANA_USER"),
    pwd: requiredEnvironment("HANA_PASSWORD"),
    encrypt: true,
    sslValidateCertificate: process.env.HANA_SSL_VALIDATE_CERTIFICATE === "true",
};

const connection = hanaClient.createConnection();
connection.connect(options, (err) => {
    if (err) throw err;
    const config = assessmentStoreConfiguration();
    connection.exec(`DROP TABLE "${config.writeSchema}"."RISK_ASSESSMENTS"`, (err) => {
        if (err) console.log("Table might not exist, skipping drop.", err.message);
        else console.log("Table dropped successfully.");
        connection.disconnect();
    });
});
