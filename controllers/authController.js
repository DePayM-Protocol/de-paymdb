const jwt = require('jsonwebtoken');
const { registerSchema, loginSchema, acceptCodeSchema, changePasswordSchema, acceptFPCodeSchema } = require("../middlewares/validator");
const { doHash, doHashValidation, hmacProcess } = require("../utils/hashing");
const User = require("../models/user");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const transport = require('../middlewares/sendMail');

const bcrypt = require('bcryptjs');


const REFERRAL_BONUS = 0.0025; // 0.25% bonus for referrals
async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
}

function randomLetter() {
  const isUpperCase = Math.random() < 0.5;
  const base = isUpperCase ? 65 : 97; // 65 for 'A', 97 for 'a'
  return String.fromCharCode(base + Math.floor(Math.random() * 26));
}

function generateVerificationCode() {
  const digits = [...Array(6)].map(() => Math.floor(Math.random() * 10).toString());
  const letters = [...Array(2)].map(() => randomLetter());
  
  const allCharacters = [...digits, ...letters];

  // Shuffle randomly
  for (let i = allCharacters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allCharacters[i], allCharacters[j]] = [allCharacters[j], allCharacters[i]];
  }

  return allCharacters.join('');
}


exports.register = async (req, res) => {
  console.log("🟢 Register route called. Request body:", req.body);

  // prefer body.referrer then query param 'ref'
  let { email, username, password, referrer } = req.body;
  const { ref } = req.query;
  if (!referrer && ref) referrer = ref;

  // Normalize referrer BEFORE validation:
  if (typeof referrer === 'string') {
    referrer = referrer.trim();
    if (
      referrer === '' ||
      referrer.toLowerCase() === 'null' ||
      referrer.toLowerCase() === 'undefined'
    ) {
      referrer = undefined;
    }
  } else if (referrer === null) {
    referrer = undefined;
  }

  // Build payload WITHOUT referrer so schema won't complain about it
  const payloadForValidation = { email, username, password };

  // Debugging (remove in production if you want)
  console.log('Register payload (for validation):', {
    email,
    username,
    password: password ? '***' : undefined,
    referrerProvided: !!referrer,
    referrerValue: referrer ? (referrer.length > 10 ? referrer.slice(0, 10) + '...' : referrer) : undefined
  });

  try {
    // Validate required fields (note: referrer purposely excluded)
    const { error, value } = registerSchema.validate(payloadForValidation, { abortEarly: false, allowUnknown: true });

if (error) {
  console.log("🛑 Joi validation failed:");
  error.details.forEach((detail, idx) => {
    console.log(`${idx + 1}. ${detail.message} (path: ${detail.path.join('.')}, type: ${detail.type}, value: ${detail.context.value})`);
  });
  return res.status(400).json({
    status: "error",
    message: "Validation failed",
    details: error.details.map(d => d.message),
  });
}

console.log("✅ Joi validation passed. Payload after validation:", value);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0]?.message.replace(/["]/g, ""),
      });
    }

    // Check if email already exists
    const existingUserByEmail = await User.findOne({ email });
    if (existingUserByEmail) {
      return res.status(400).json({
        success: false,
        message: "User already exists with this email!",
      });
    }

    // Check if username already exists
    const existingUserByUsername = await User.findOne({ username });
    if (existingUserByUsername) {
      return res.status(400).json({
        success: false,
        message: "Username is already taken!",
      });
    }

    // Hash the password
    const hashedPassword = await doHash(password, 12);

    // Create new user with optional referral
    const newUser = new User({
      email,
      username,
      password: hashedPassword,
    });

    // Apply referral only if referrer is defined and valid 0x address
    if (referrer) {
      const is0x = /^0x[a-fA-F0-9]{40}$/.test(referrer);
      if (!is0x) {
        console.warn('Referrer provided but invalid format — ignoring:', referrer);
      } else {
        const referringUser = await User.findOne({
          'wallets.address': referrer.toLowerCase()
        });
        if (!referringUser) {
          console.warn('Referrer address not found in DB — continuing without referral:', referrer);
        } else {
          newUser.referredBy = referringUser._id;
          referringUser.referrals.push(newUser._id);
          referringUser.ratePerHour = parseFloat(
            (referringUser.ratePerHour + REFERRAL_BONUS).toFixed(6)
          );
          await referringUser.save();
        }
      }
    }

    const result = await newUser.save();

    // Remove sensitive data before sending response
    const { password: _, ...safeUser } = result.toObject();

    return res.status(201).json({
      success: true,
      message: "Your account has been created successfully",
      result: safeUser,
    });

  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error. Please try again later.",
    });
  }
};




exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const { error } = loginSchema.validate({ email, password });
    if (error) {
      return res.status(401).json({
        success: false,
        message: error.details[0]?.message.replace(/["]/g, "")
      });
    }

    const existingUser = await User.findOne({ email }).select('+password');
    if (!existingUser) {
      return res.status(401).json({
        success: false,
        message: "User does not exist!"
      });
    }
    if (!existingUser.verified) {
      return res.status(403).json({
        success: false,
        needsVerification: true,
        message: "Account requires verification"
      });
    }

    const isValid = await doHashValidation(password, existingUser.password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials!'
      });
    }
/*
    const token = jwt.sign(
      { 
        userId: existingUser._id,
        email: existingUser.email,
        verified: existingUser.verified,
      },
      process.env.TOKEN_SECRET,
      { expiresIn: "14d" }
    );

    const userData = {
      _id: existingUser._id,
      email: existingUser.email,
      verified: existingUser.verified,
      // Add other non-sensitive fields if needed
    };
    
    res.cookie('Authorisation', 'Bearer ' + token, {
      expires: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      httpOnly: process.env.NODE_ENV === 'production',
      secure: process.env.NODE_ENV === 'production'
    }).json({
      success: true,
      token,
      user: userData,
      message: 'Logged in successfully',
    });
*/
    // 1 year in seconds and ms
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;        // 31536000
const ONE_YEAR_MS = ONE_YEAR_SECONDS * 1000;        // 31536000000

const token = jwt.sign(
  { 
    userId: existingUser._id,
    email: existingUser.email,
    verified: existingUser.verified,
  },
  process.env.TOKEN_SECRET,
  { expiresIn: ONE_YEAR_SECONDS } // expiresIn accepts seconds or string like '1y'
);

const userData = {
      _id: existingUser._id,
      email: existingUser.email,
      verified: existingUser.verified,
      // Add other non-sensitive fields if needed
    };

// set cookie to expire in 1 year as well
res.cookie('Authorisation', 'Bearer ' + token, {
  expires: new Date(Date.now() + ONE_YEAR_MS),
  httpOnly: process.env.NODE_ENV === 'production',
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}).json({
  success: true,
  token,
  user: userData,
  message: 'Logged in successfully',
});

    

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
    });
  }
};
exports.addWallet = async (req, res) => {
  const walletAddress = req.body.walletAddress?.toLowerCase();
  const userId = req.user.id;

  try {
    if (!walletAddress || !walletAddress.startsWith('0x')) {
      return res.status(400).json({ message: 'Invalid wallet address format' });
    }

    const existingUser = await User.findOne({ 
      'wallets.address': walletAddress 
    });

    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(409).json({ message: 'Wallet already linked to another User' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Check if wallet exists using proper object structure
    const exists = user.wallets.some(w => w.address === walletAddress);
    if (exists) return res.json({ success: true, wallets: user.wallets });

    // Add new wallet with proper structure
    user.wallets.push({ address: walletAddress });
    
    // Validate before saving
    await user.validate();
    await user.save();

    return res.json({ success: true, wallets: user.wallets });

  } catch (error) {
    console.error("Add wallet error:", error);
    return res.status(500).json({ 
      message: "Validation failed",
      error: error.message,
      fields: error.errors ? Object.keys(error.errors) : []
    });
  }
};


exports.logout = async (req, res) => {
  res.clearCookie('Authorisation').status(200).json({
    success: true,
    message: 'Logged out successfully'
  });
};

exports.sendVerificationCode = async (req, res) => {
  try {
    const { email } = req.body;
    console.log("Attempting to send code to:", email);

    const existingUser = await User.findOne({ email });
    if (!existingUser) {
      console.log("User not found for email:", email);
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

        const codeValue = generateVerificationCode();
    console.log("Generated code:", codeValue);
    

    const mailOptions = {
      from: `"De-PayM Team" <${process.env.NODE_SENDER_EMAIL_USER}>`,
      to: email,
      subject: "🔐 Your De-PayM Verification Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border-radius: 10px; background: linear-gradient(to right, #2EC1EA, #443D3D); color: #ffffff;">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="LOGO_URL_HERE" alt="De-PayM Logo" style="max-width: 150px;" />
          </div>
          <h2 style="text-align: center;">Welcome to De-PayM 🚀</h2>
          <p style="font-size: 16px;">Hi there,</p>
          <p style="font-size: 16px;">
            To continue setting up your De-PayM account, please use the verification code below:
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <span style="display: inline-block; padding: 15px 30px; font-size: 26px; font-weight: bold; background-color: #ffffff; color: #2EC1EA; border-radius: 8px;">
              ${codeValue}
            </span>
          </div>
          <p style="font-size: 14px;">This code will expire in 10 minutes.</p>
          <p style="font-size: 14px;">If you didn't request this, you can safely ignore it.</p>
          <p style="margin-top: 30px;">Thanks,<br/>The De-PayM Team</p>
        </div>
      `
    };
    
    
 

    console.log("Sending email with options:", mailOptions);
    const info = await transport.sendMail(mailOptions);
    console.log("Email sent info:", info);

    if (info.accepted.includes(email)) {
      const hashedCode = hmacProcess(codeValue, process.env.HMAC_VERIFICATION_CODE_SECRET);
      console.log("Stored HMAC:", hashedCode);
      await User.updateOne(
        { email },
        {
          verificationCode: hashedCode,
          verificationCodeValidation: Date.now()
        }
      );
      return res.json({ success: true, message: "Code sent" });
    }
   // const hashedCode = hmacProcess(codeValue, process.env.HMAC_VERIFICATION_CODE_SECRET);
    

    throw new Error(`Email rejected. Server response: ${JSON.stringify(info)}`);

  } catch (error) {
    console.error("Full error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send code",
      error: error.message
    });
  }
};

exports.verifyVerificationCode = async (req, res) => {
  const { email, providedCode } = req.body;

  try {
    const { error } = acceptCodeSchema.validate({ email, providedCode });
    if (error) {
      return res.status(401).json({
        success: false,
        message: error.details[0]?.message.replace(/["]/g, "")
      });
    }

    const existingUser = await User.findOne({ email }).select("verificationCode verificationCodeValidation verified");
    if (!existingUser) {
      return res.status(401).json({
        success: false,
        message: "User does not exist!"
      });
    }

    if (existingUser.verified) {
      return res.status(400).json({
        success: false,
        message: "You are already verified"
      });
    }

    if (!existingUser.verificationCode || !existingUser.verificationCodeValidation) {
      return res.status(400).json({
        success: false,
        message: 'Something is wrong with the code!'
      });
    }

    if (Date.now() - existingUser.verificationCodeValidation > 10 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        message: 'The verification code has expired'
      });
    }

    const hashedCode = hmacProcess(providedCode.toString(), process.env.HMAC_VERIFICATION_CODE_SECRET);

    if (hashedCode === existingUser.verificationCode) {
      existingUser.verified = true;
      existingUser.verificationCode = undefined;
      existingUser.verificationCodeValidation = undefined;
      await existingUser.save();

      return res.status(200).json({
        success: true,
        message: 'Your account is now verified'
      });
    }
    
    return res.status(400).json({
      success: false,
      message: 'Unexpected error occurred!'
    });
    


  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Server error during verification'
    });
  }
};

// Add this to your backend controller
exports.checkVerification = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    return res.json({ 
      success: true, 
      verified: user.verified 
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "Error checking verification status" 
    });
  }
};

exports.changePassword = async (req, res) => {
  const { userId, verified } = req.user;
  const {  oldPassword, newPassword } = req.body;

  try {
    const { error } = changePasswordSchema.validate({ oldPassword, newPassword });
    if (error) {
      return res.status(401).json({
        success: false,
        message: error.details[0]?.message.replace(/["]/g, "")
      });
    }
    if (!verified) {
      return res.status(401).json({
        success: false,
        message: "You need to verify your account first"
      });
    }

    const existingUser = await User.findOne({ _id:userId }).select('+password');
    if (!existingUser) {
      return res.status(401).json({
        success: false,
        message: "User does not exist!"
      });
    }

    const isValid = await doHashValidation(oldPassword, existingUser.password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials!'
      });
    }

    const hashedPassword = await doHash(newPassword, 12);
    existingUser.password = hashedPassword;
    await existingUser.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
    });
  }
};



exports.sendForgotPasswordCode = async (req, res) => {
  try {
    const { email } = req.body;
    console.log("Attempting to send code to:", email);

    const existingUser = await User.findOne({ email });
    if (!existingUser) {
      console.log("User not found for email:", email);
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const codeValue = generateVerificationCode();
    console.log("Generated code:", codeValue);

    const mailOptions = {
      from: `"De-PayM Team" <${process.env.NODE_SENDER_EMAIL_USER}>`,
      to: email,
      subject: "🔐 Your De-PayM Forgot Password Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border-radius: 10px; background: linear-gradient(to right, #2EC1EA, #443D3D); color: #ffffff;">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="LOGO_URL_HERE" alt="De-PayM Logo" style="max-width: 150px;" />
          </div>
          <h2 style="text-align: center;"> De-PayM 🚀</h2>
          <p style="font-size: 16px;">Hi there,</p>
          <p style="font-size: 16px;">
            To continue setting up your De-PayM account, please use the verification code below to change your password:
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <span style="display: inline-block; padding: 15px 30px; font-size: 26px; font-weight: bold; background-color: #ffffff; color: #2EC1EA; border-radius: 8px;">
              ${codeValue}
            </span>
          </div>
          <p style="font-size: 14px;">This code will expire in 5 minutes.</p>
          <p style="font-size: 14px;">If you didn't request this, you can safely ignore it.</p>
          <p style="margin-top: 30px;">Thanks,<br/>The De-PayM Team</p>
        </div>
      `
    };
    
    
 

    console.log("Sending email with options:", mailOptions);
    const info = await transport.sendMail(mailOptions);
    console.log("Email sent info:", info);

    if (info.accepted.includes(email)) {
      const hashedCode = hmacProcess(codeValue, process.env.HMAC_VERIFICATION_CODE_SECRET);
      await User.updateOne(
        { email },
        {
          forgotPasswordCode: hashedCode,
          forgotPasswordCodeValidation: Date.now()
        }
      );
      return res.json({ success: true, message: "Code sent" });
    }

    throw new Error(`Email rejected. Server response: ${JSON.stringify(info)}`);

  } catch (error) {
    console.error("Full error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send code",
      error: error.message
    });
  }
};

exports.verifyForgotPasswordCode = async (req, res) => {
  const { email, providedCode, newPassword } = req.body;

  try {
    const { error } = acceptFPCodeSchema.validate({ email, providedCode, newPassword });
    if (error) {
      return res.status(401).json({
        success: false,
        message: error.details[0]?.message.replace(/["]/g, "")
      });
    }

    const codeValue = providedCode.toString();
    const existingUser = await User.findOne({ email }).select("password forgotPasswordCode forgotPasswordCodeValidation");

    if (!existingUser) {
      return res.status(401).json({
        success: false,
        message: "User does not exist!"
      });
    }
    if (!existingUser.forgotPasswordCode || !existingUser.forgotPasswordCodeValidation) {
      return res.status(400).json({
        success: false,
        message: 'Something is wrong with the code!'
      });
    }
    if (Date.now() - existingUser.forgotPasswordCodeValidation > 5 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        message: 'The verification code has expired'
      });
    }

    const isValid = await doHashValidation(newPassword, existingUser.password);
    if (isValid) {
      return res.status(400).json({
        success: false,
        message: 'You cannot use the same password!'
      });
    }
    const hashedPassword = await hashPassword(newPassword);
    const hashedCode = hmacProcess(providedCode.toString(), process.env.HMAC_VERIFICATION_CODE_SECRET);
    if (hashedCode === existingUser.forgotPasswordCode) {
      existingUser.password = hashedPassword;
      existingUser.forgotPasswordCode = undefined;
      existingUser.forgotPasswordCodeValidation = undefined;
      await existingUser.save();

      return res.status(200).json({
        success: true,
        message: 'Your password has been changed successfully'
      });
    }
    
    return res.status(400).json({
      success: false,
      message: 'Unexpected error occurred!'
    });
    


  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Server error during verification'
    });
  }
};

