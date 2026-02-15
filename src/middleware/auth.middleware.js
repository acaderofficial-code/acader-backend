import admin from "../config/firebase.js";
import pool from "../config/db.js";

export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = decoded.email ?? null;

    let result = await pool.query(
      "SELECT id, role FROM users WHERE firebase_uid = $1",
      [decoded.uid],
    );

    // Backfill firebase_uid for older users created by email-only logic.
    if (result.rows.length === 0 && email) {
      const byEmail = await pool.query(
        "SELECT id, role, firebase_uid FROM users WHERE email = $1",
        [email],
      );

      if (byEmail.rows.length > 0) {
        const user = byEmail.rows[0];
        if (!user.firebase_uid) {
          await pool.query("UPDATE users SET firebase_uid = $1 WHERE id = $2", [
            decoded.uid,
            user.id,
          ]);
        }
        result = { rows: [{ id: user.id, role: user.role }] };
      }
    }

    if (result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO users (firebase_uid, email, role)
         VALUES ($1, $2, 'user')
         RETURNING id, role`,
        [decoded.uid, email],
      );
    }

    req.user = {
      uid: decoded.uid,
      email,
      id: result.rows[0].id,
      role: result.rows[0].role,
    };

    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};
