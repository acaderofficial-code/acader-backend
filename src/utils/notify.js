// utils/notify.js
import pool from "../config/db.js";

// Core notification creator
export async function createNotification({
  user_id,
  type,
  message,
  related_id = null,
}) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, message, related_id)
     VALUES ($1, $2, $3, $4)`,
    [user_id, type, message, related_id]
  );
  console.log("🔔 Notification created for user", user_id, type);
}

// Safe wrapper (never crashes your app)
export const safeNotify = async (
  user_id,
  type,
  message,
  related_id = null
) => {
  try {
    await createNotification({
      user_id,
      type,
      message,
      related_id,
    });
  } catch (e) {
    console.error("Notification failed:", e.message);
  }
};
