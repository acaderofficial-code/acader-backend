import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const requiredFirebaseEnv = {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const missingEnv = Object.entries(requiredFirebaseEnv)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnv.length > 0) {
  throw new Error(
    `Missing Firebase environment variables: ${missingEnv.join(", ")}`,
  );
}

const firebaseConfig = {
  apiKey: requiredFirebaseEnv.NEXT_PUBLIC_FIREBASE_API_KEY as string,
  authDomain: requiredFirebaseEnv.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN as string,
  projectId: requiredFirebaseEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID as string,
  storageBucket: requiredFirebaseEnv.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId:
    requiredFirebaseEnv.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: requiredFirebaseEnv.NEXT_PUBLIC_FIREBASE_APP_ID as string,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
