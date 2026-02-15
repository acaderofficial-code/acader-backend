import { pool } from "./src/config/db.js";

const res = await pool.query("SELECT NOW()");
console.log(res.rows);
process.exit();
