import express from "express";
import pool from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

/**
 * Create review (authenticated; reviewer_id from token)
 */
router.post(
  "/",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { reviewed_id, project_id, rating, comment } = req.body;
    const reviewer_id = req.user.id;
    const reviewedId = Number(reviewed_id);
    const projectId = Number(project_id);
    const numericRating = Number(rating);

    if (!Number.isInteger(reviewedId) || reviewedId <= 0) {
      return res.status(400).json({ message: "Invalid reviewed_id" });
    }
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "Invalid project_id" });
    }
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: "rating must be between 1 and 5" });
    }
    if (reviewedId === reviewer_id) {
      return res.status(400).json({ message: "You cannot review yourself" });
    }

    const result = await pool.query(
      `INSERT INTO reviews (reviewer_id, reviewed_id, project_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [reviewer_id, reviewedId, projectId, numericRating, comment ?? null],
    );

    res.status(201).json(result.rows[0]);
  })
);

/**
 * Get reviews for a user (public)
 */
router.get(
  "/user/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const result = await pool.query(
      `SELECT * FROM reviews WHERE reviewed_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    res.json(result.rows);
  }),
);

export default router;
