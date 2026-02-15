"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";
import styles from "./page.module.css";

export default function PayPage() {
  const { authHeaders, isAuthenticated, isLoading } = useAuth();
  const [amount, setAmount] = useState("5000");
  const [email, setEmail] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    setError(null);
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!email) {
      setError("Enter a valid email");
      return;
    }
    const numericCompanyId = Number(companyId);
    if (!Number.isInteger(numericCompanyId) || numericCompanyId <= 0) {
      setError("Enter a valid company ID");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/paystack/initialize"), {
        method: "POST",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({
          amount: numericAmount,
          email,
          company_id: numericCompanyId,
          project_id: projectId ? Number(projectId) : undefined,
          application_id: applicationId ? Number(applicationId) : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to initialize payment");
      }

      if (!data.authorization_url) {
        throw new Error("No authorization URL returned");
      }

      window.location.href = data.authorization_url;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Payment init failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Pay with Paystack</h1>
      {isLoading ? (
        <p className={styles.notice}>Loading authentication...</p>
      ) : !isAuthenticated ? (
        <p className={styles.notice}>Please log in to continue.</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            handlePay();
          }}
        >
          <div className={styles.field}>
            <label htmlFor="pay-email" className={styles.label}>
              Email
            </label>
            <input
              id="pay-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="pay-company" className={styles.label}>
              Company ID
            </label>
            <input
              id="pay-company"
              name="company_id"
              type="number"
              min="1"
              inputMode="numeric"
              required
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="pay-project" className={styles.label}>
              Project ID (optional)
            </label>
            <input
              id="pay-project"
              name="project_id"
              type="number"
              min="1"
              inputMode="numeric"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="pay-application" className={styles.label}>
              Application ID (optional)
            </label>
            <input
              id="pay-application"
              name="application_id"
              type="number"
              min="1"
              inputMode="numeric"
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="pay-amount" className={styles.label}>
              Amount (NGN)
            </label>
            <input
              id="pay-amount"
              name="amount"
              type="number"
              min="1"
              inputMode="numeric"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={styles.input}
            />
          </div>
          {error && (
            <p className={styles.error}>{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className={styles.button}
          >
            {loading ? "Initializing..." : "Pay with Paystack"}
          </button>
        </form>
      )}
    </div>
  );
}
