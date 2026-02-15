import nodemailer from "nodemailer";

export const sendEmail = async (to, subject, html) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER, // your gmail
      pass: process.env.EMAIL_PASS, // app password
    },
  });

  await transporter.sendMail({
    from: `"ACADER" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });

  console.log(`📧 Email sent to ${to}`);
};
