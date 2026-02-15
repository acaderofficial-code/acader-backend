import express from "express";
import cors from "cors";
import helmet from "helmet";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import reviewRoutes from "./routes/review.routes.js";
import paystackRoutes from "./routes/paystack.routes.js";
import projectRoutes from "./routes/project.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import withdrawalsRoutes from "./routes/withdrawals.routes.js";
import notificationRoutes from "./routes/notifications.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());

const corsOrigin = process.env.CORS_ORIGIN || "*";
const allowAnyOrigin = corsOrigin === "*";
const allowedOrigins = allowAnyOrigin
  ? true
  : [
      ...corsOrigin.split(",").map((o) => o.trim()),
      "http://localhost:3000",
      "http://localhost:3001",
    ];
app.use(
  cors({
    origin: allowedOrigins,
    credentials: allowAnyOrigin ? false : true,
  }),
);
app.use("/api/webhooks/paystack", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("ACADER BACKEND IS ALIVE");
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/paystack", paystackRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdrawals", withdrawalsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/webhooks", webhookRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.message ?? "Internal server error";
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ message });
});

export default app;
