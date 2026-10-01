// Low limits for rate-limit.test.js; imported before helpers.js, which only
// fills in limits that are not set yet.
process.env.RATE_LIMIT_API_PER_MINUTE = '150';
process.env.RATE_LIMIT_LOGIN_PER_15_MINUTES = '4';
process.env.RATE_LIMIT_LOGIN_PER_EMAIL = '2';
process.env.RATE_LIMIT_REGISTER_PER_HOUR = '2';
process.env.RATE_LIMIT_WEBHOOKS_PER_MINUTE = '3';
process.env.RATE_LIMIT_DEPLOYMENTS_PER_MINUTE = '3';
process.env.RATE_LIMIT_PROJECTS_PER_HOUR = '3';
