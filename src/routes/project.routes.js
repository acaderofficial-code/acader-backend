import express from "express";
import pool from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

/**
 * Update project status (admin only)
 */
router.patch(
  "/:id/status",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;

    const allowed = ["open", "in_progress", "completed"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const result = await pool.query(
      `UPDATE projects SET status=$1 WHERE id=$2 RETURNING *`,
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    res.json({
      message: `Project marked as ${status}`,
      project: result.rows[0],
    });
  })
);

export default router;
