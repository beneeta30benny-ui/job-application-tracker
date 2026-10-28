
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();
const Application = require("./models/Application");
const ApplicationSequence = require("./models/ApplicationSequence");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/applications", require("./routes/application"));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Job Application Tracker API is running",
    data: null
  });
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    await Promise.all([Application.init(), ApplicationSequence.init()]);
    console.log("MongoDB Atlas connected");

    const port = process.env.PORT || 5000;
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Database startup error:", error.message);
  });
