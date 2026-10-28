// Shared development baseline: never connect the simulator to the customer service.
// A release configuration is a separate reviewed operation, not a developer default.
module.exports = { transport:'http', apiBaseUrl:'http://127.0.0.1:5187/api' };
