import express from "express";
import pool from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

/**
 * Get current user's notifications (authenticated; only own)
 */
router.get(
  "/user/:id",
  verifyToken,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id !== req.user.id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    res.json(result.rows);
  })
);

/**
 * Mark notification as read (authenticated; only own notification)
 */
router.patch(
  "/:id/read",
  verifyToken,
  asyncHandler(async (req, res) => {
    const notifId = parseInt(req.params.id, 10);
    if (Number.isNaN(notifId)) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const result = await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *`,
      [notifId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Notification not found" });
    }
    res.json(result.rows[0]);
  })
);

export default router;
