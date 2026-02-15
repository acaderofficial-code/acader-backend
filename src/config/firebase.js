import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localServiceAccountPath = path.join(__dirname, "firebaseServiceAccount.json");
const envServiceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const inlineServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!admin.apps.length) {
  if (inlineServiceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(inlineServiceAccount)),
    });
  } else if (envServiceAccountPath && fs.existsSync(envServiceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(envServiceAccountPath, "utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else if (fs.existsSync(localServiceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(localServiceAccountPath, "utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp();
  }
}

export default admin;
