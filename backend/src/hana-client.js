import hana from "@sap/hana-client";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "team_12.env") });

const connOptions = {
    serverNode: `${process.env.HANA_HOST}:443`,
    uid: process.env.HANA_USER,
    pwd: process.env.HANA_PASSWORD,
    encrypt: "true",
    sslValidateCertificate: "false",
    sslHostNameInCertificate: "*"
};

const pool = hana.createPool(connOptions);

export async function persistRiskScore(alertId, resultData) {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, conn) => {
            if (err) return reject(err);
            
            const transactionId = parseInt(resultData.transactionId, 10);
            const parsedAlertId = parseInt(alertId, 10);
            
            // Generate a SCORE_ID using MAX + 1
            const idSql = `SELECT COALESCE(MAX(SCORE_ID), 0) + 1 AS NEXT_ID FROM "TEAM_12"."TRANSACTION_RISK_SCORES"`;
            
            conn.exec(idSql, (err, rows) => {
                if (err) {
                    conn.close();
                    return reject(err);
                }
                const scoreId = rows[0].NEXT_ID;
                
                // Write into TRANSACTION_RISK_SCORES
                const sql = `
                    INSERT INTO "TEAM_12"."TRANSACTION_RISK_SCORES" (
                        SCORE_ID,
                        TRANSACTION_ID,
                        OVERALL_RISK_SCORE,
                        RISK_TIER,
                        AMOUNT_RISK_SCORE,
                        FREQUENCY_RISK_SCORE,
                        GEOGRAPHY_RISK_SCORE,
                        COUNTERPARTY_RISK_SCORE,
                        PATTERN_RISK_SCORE,
                        VELOCITY_RISK_SCORE,
                        MODEL_CONFIDENCE,
                        IS_ANOMALY,
                        SCORED_AT
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `;
                
                // Parse scores from resultData
                const compositeScore = resultData.assessment.overallScore;
                const riskTier = resultData.assessment.riskLevel;
                
                // Map sub-scores
                let amountScore = 0;
                let frequencyScore = 0;
                let geographyScore = 0;
                let counterpartyScore = 0;
                let patternScore = 0;
                let velocityScore = 0;
                
                const triggered = resultData.rulesTriggered || [];
                triggered.forEach(rule => {
                    const id = rule.ruleId || "";
                    const pts = rule.points || 0;
                    if (id.includes("AMOUNT")) amountScore += pts;
                    else if (id.includes("FATF") || id.includes("COUNTRY") || id.includes("DESTINATION")) geographyScore += pts;
                    else if (id.includes("DAILY") || id.includes("RAPID") || id.includes("VELOCITY")) velocityScore += pts;
                    else if (id.includes("STRUCTURING") || id.includes("PATTERN")) patternScore += pts;
                    else if (id.includes("KYC") || id.includes("PEP") || id.includes("COUNTERPARTY") || id.includes("MEDIA")) counterpartyScore += pts;
                    else frequencyScore += pts;
                });
                
                const args = [
                    scoreId,
                    transactionId,
                    compositeScore,
                    riskTier,
                    amountScore,
                    frequencyScore,
                    geographyScore,
                    counterpartyScore,
                    patternScore,
                    velocityScore,
                    0.0, // Model Confidence
                    false // Is Anomaly
                ];
                
                conn.exec(sql, args, (err) => {
                    conn.close();
                    if (err) return reject(err);
                    resolve(scoreId);
                });
            });
        });
    });
}
