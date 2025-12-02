const Joi = require('joi');

exports.registerSchema = Joi.object({
  username: Joi.string()
    .min(3)
    .max(30)
    .required()
    .pattern(new RegExp("^[a-zA-Z0-9_]+$"))
    .messages({
      "string.pattern.base":
        "Username must be 3-30 characters long and contain only letters, numbers, or underscores",
      "string.min": "Username must be at least 3 characters",
      "string.max": "Username must be at most 30 characters",
      "any.required": "Username is required",
    }),

  email: Joi.string()
    .min(6)
    .max(60)
    .required()
    .email()
    .pattern(new RegExp("@.+\\.(com|net|org|io|co)$"))
    .messages({
      "string.pattern.base":
        "Email must end with .com, .net, .org, .io, or .co",
      "string.email": "Invalid email format",
      "string.min": "Email must be at least 6 characters",
      "string.max": "Email must be at most 60 characters",
      "any.required": "Email is required",
    }),

  password: Joi.string()
    .pattern(
      new RegExp("^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d@$!%*?&]{8,}$")
    )
    .required()
    .messages({
      "string.pattern.base":
        "Password must have at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number",
      "any.required": "Password is required",
    }),

  // validator (validator.js / middlewares/validator.js)
  referrer: Joi.string()
  .pattern(/^0x[a-fA-F0-9]{40}$/)
  .messages({
    "string.pattern.base":
      "Referrer must be a valid 42-character Ethereum address starting with 0x",
  })
  .allow(null)     // allow null explicitly
  .allow("")       // allow empty string explicitly
  .optional()      // allow the field to be omitted entirely

});

exports.loginSchema = Joi.object({
  email: Joi.string()
    .min(6)
    .max(60)
    .required()
    .email()
    .pattern(new RegExp('@.+\\.(com|net|org|io|co)$'))
    .messages({
      'string.pattern.base': 'Email must end with .com, .net, .org, .io, or .co',
      'string.email': 'Invalid email format',
      'string.min': 'Email must be at least 6 characters',
      'string.max': 'Email must be at most 60 characters',
      'any.required': 'Email is required'
    }),

  password: Joi.string()
    .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d@$!%*?&]{8,}$'))
    .required()
    .messages({
      'string.pattern.base': 'Password must have at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number',
      'any.required': 'Password is required'
    })
});

exports.acceptCodeSchema = Joi.object({
  email: Joi.string()
    .min(6)
    .max(60)
    .required()
    .email()
    .pattern(new RegExp('@.+\\.(com|net|org|io|co)$'))
    .messages({
      'string.pattern.base': 'Email must end with .com, .net, .org, .io, or .co',
      'string.email': 'Invalid email format',
      'string.min': 'Email must be at least 6 characters',
      'string.max': 'Email must be at most 60 characters',
      'any.required': 'Email is required'
    }),

  providedCode: Joi.string()
    .required()
    .messages({
      'any.required': 'Provided code is required'
    })
});

exports.changePasswordSchema = Joi.object({
  newPassword: Joi.string()
    .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d@$!%*?&]{8,}$'))
    .required()
    .messages({
      'string.pattern.base': 'New password must have at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number',
      'any.required': 'New password is required'
    }),

  oldPassword: Joi.string()
    .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d@$!%*?&]{8,}$'))
    .required()
    .messages({
      'string.pattern.base': 'Old password must have at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number',
      'any.required': 'Old password is required'
    })
});

exports.acceptFPCodeSchema = Joi.object({
  email: Joi.string()
    .min(6)
    .max(60)
    .required()
    .email()
    .pattern(new RegExp('@.+\\.(com|net|org|io|co)$'))
    .messages({
      'string.pattern.base': 'Email must end with .com, .net, .org, .io, or .co',
      'string.email': 'Invalid email format',
      'string.min': 'Email must be at least 6 characters',
      'string.max': 'Email must be at most 60 characters',
      'any.required': 'Email is required'
    }),

  providedCode: Joi.string()
    .required()
    .messages({
      'any.required': 'Provided code is required'
    }),

  newPassword: Joi.string()
    .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d@$!%*?&]{8,}$'))
    .required()
    .messages({
      'string.pattern.base': 'New password must have at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number',
      'any.required': 'New password is required'
    })
});


