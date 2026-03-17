import { Firestore } from "@google-cloud/firestore";

const projectId =
  process.env.FIRESTORE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT;

export const db = new Firestore(
  projectId
    ? {
        projectId,
      }
    : undefined,
);
