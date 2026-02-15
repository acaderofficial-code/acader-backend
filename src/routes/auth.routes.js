import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/me", verifyToken, (req, res) => {
  res.json({
    message: "You are authenticated",
    user: req.user,
  });
});

router.get("/test", verifyToken, (req, res) => {
  res.json(req.user);
});


export default router;
