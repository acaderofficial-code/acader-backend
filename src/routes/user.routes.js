import express from "express";
import pool from "../config/db.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/sync", verifyToken, async (req, res) => {
  const { uid, email } = req.user;

  try {
    const existing = await pool.query(
      "SELECT * FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (existing.rows.length > 0) {
      const updated = await pool.query(
        "UPDATE users SET email = $1 WHERE id = $2 RETURNING *",
        [email ?? null, existing.rows[0].id],
      );
      return res.json(updated.rows[0]);
    }

    const created = await pool.query(
      `INSERT INTO users (firebase_uid, email)
       VALUES ($1, $2) RETURNING *`,
      [uid, email ?? null],
    );

    res.json(created.rows[0]);
  } catch (err) {
    console.error("DB ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
