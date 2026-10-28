const mongoose = require("mongoose");

const applicationSequenceSchema = new mongoose.Schema({
  prefix: {
    type: String,
    required: true,
    unique: true
  },
  sequence: {
    type: Number,
    default: 0
  }
});

module.exports = mongoose.model("ApplicationSequence", applicationSequenceSchema);
