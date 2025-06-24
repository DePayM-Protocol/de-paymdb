const nodemailer = require('nodemailer');

// Create Zoho transporter
const transport = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false, // TLS
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS,
  },
});

// Verify connection
transport.verify((error, success) => {
  if (error) {
    console.error('❌ Brevo SMTP transport failed:', error);
  } else {
    console.log('✅ Brevo SMTP is ready to send emails');
  }
});

module.exports = transport;


