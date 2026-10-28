const express = require("express");
const Application = require("../models/Application");
const ApplicationSequence = require("../models/ApplicationSequence");

const router = express.Router();

const statuses = [
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
  "Accepted",
  "Declined"
];
const finalStatuses = ["Rejected", "Accepted", "Declined"];
const transitions = {
  Applied: ["Interview", "Rejected"],
  Interview: ["Offer", "Rejected"],
  Offer: ["Accepted", "Declined"]
};

const response = (success, message, data = null) => ({
  success,
  message,
  data
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sendError(res, error) {
  if (error.name === "CastError" && error.path === "_id") {
    return res.status(400).json(response(false, "Invalid application ID"));
  }

  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json(response(false, error.message));
  }

  if (error.code === 11000) {
    return res.status(409).json(
      response(false, "An application with this ID already exists")
    );
  }

  console.error("Application API error:", error);
  return res.status(500).json(response(false, "An unexpected server error occurred"));
}

function companyPrefix(companyName) {
  return companyName
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, "X");
}

async function nextSequence(prefix) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const counter = await ApplicationSequence.findOneAndUpdate(
        { prefix },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return counter.sequence;
    } catch (error) {
      if (error.code !== 11000 || attempt === 2) throw error;
    }
  }
}

async function generateId(companyName) {
  const prefix = companyPrefix(companyName);

  while (true) {
    const sequence = await nextSequence(prefix);
    const applicationId = `JA-${prefix}-${String(sequence).padStart(3, "0")}`;

    if (!(await Application.exists({ applicationId }))) {
      return applicationId;
    }
  }
}

async function findActiveDuplicate(companyName, jobRole, excludedId) {
  const query = {
    companyName: {
      $regex: `^${escapeRegex(companyName.trim())}$`,
      $options: "i"
    },
    jobRole: {
      $regex: `^${escapeRegex(jobRole.trim())}$`,
      $options: "i"
    },
    status: { $nin: finalStatuses }
  };

  if (excludedId) query._id = { $ne: excludedId };
  return Application.findOne(query);
}

router.post("/", async (req, res) => {
  try {
    const {
      companyName,
      jobRole,
      jobType,
      appliedDate,
      expectedSalary,
      notes
    } = req.body || {};

    if (
      typeof companyName !== "string" ||
      !companyName.trim() ||
      typeof jobRole !== "string" ||
      !jobRole.trim() ||
      !jobType ||
      !appliedDate
    ) {
      return res.status(400).json(
        response(false, "Please fill all required fields")
      );
    }

    const date = new Date(appliedDate);
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json(response(false, "Invalid applied date"));
    }

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (date > today) {
      return res.status(400).json(
        response(false, "Applied date cannot be in the future")
      );
    }

    if (await findActiveDuplicate(companyName, jobRole)) {
      return res.status(409).json(
        response(
          false,
          "An active application for this company and role already exists"
        )
      );
    }

    const application = await Application.create({
      applicationId: await generateId(companyName.trim()),
      companyName: companyName.trim(),
      jobRole: jobRole.trim(),
      jobType,
      appliedDate: date,
      expectedSalary,
      notes,
      status: "Applied",
      statusHistory: [{ status: "Applied", date: new Date() }],
      followUpDate: new Date(date.getTime() + 7 * 86400000)
    });

    return res.status(201).json(
      response(true, "Application created successfully", application)
    );
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/", async (req, res) => {
  try {
    const { status, company } = req.query;
    if (status && !statuses.includes(status)) {
      return res.status(400).json(response(false, "Invalid application status"));
    }
    if (company !== undefined && typeof company !== "string") {
      return res.status(400).json(
        response(false, "Company search must be a single string")
      );
    }

    const filter = {};
    if (status) filter.status = status;
    if (company) {
      filter.companyName = {
        $regex: escapeRegex(company),
        $options: "i"
      };
    }

    const [applications, groupedCounts] = await Promise.all([
      Application.find(filter).sort({ createdAt: -1 }).lean(),
      Application.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ])
    ]);

    const counts = Object.fromEntries(statuses.map(item => [item, 0]));
    groupedCounts.forEach(item => {
      counts[item._id] = item.count;
    });

    const now = new Date();
    const data = applications.map(application => ({
      ...application,
      isOverdue: application.status === "Applied" &&
        now >= new Date(application.followUpDate)
    }));

    return res.json(
      response(true, "Applications fetched successfully", {
        applications: data,
        counts
      })
    );
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) {
      return res.status(404).json(response(false, "Application not found"));
    }

    return res.json(
      response(true, "Application fetched successfully", application)
    );
  } catch (error) {
    return sendError(res, error);
  }
});

router.put("/:id", async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) {
      return res.status(404).json(response(false, "Application not found"));
    }

    const updates = req.body || {};
    const companyName = updates.companyName === undefined
      ? application.companyName
      : updates.companyName;
    const jobRole = updates.jobRole === undefined
      ? application.jobRole
      : updates.jobRole;

    if (
      typeof companyName !== "string" ||
      !companyName.trim() ||
      typeof jobRole !== "string" ||
      !jobRole.trim()
    ) {
      return res.status(400).json(
        response(false, "Company name and job role are required")
      );
    }

    if (
      !finalStatuses.includes(application.status) &&
      await findActiveDuplicate(companyName, jobRole, application._id)
    ) {
      return res.status(409).json(
        response(
          false,
          "An active application for this company and role already exists"
        )
      );
    }

    application.companyName = companyName.trim();
    application.jobRole = jobRole.trim();
    if (updates.jobType !== undefined) application.jobType = updates.jobType;
    if (updates.expectedSalary !== undefined) {
      application.expectedSalary = updates.expectedSalary;
    }
    if (updates.notes !== undefined) application.notes = updates.notes;

    await application.save();
    return res.json(
      response(true, "Application updated successfully", application)
    );
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) {
      return res.status(404).json(response(false, "Application not found"));
    }

    const { status } = req.body || {};
    const allowed = transitions[application.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json(
        response(
          false,
          `Cannot change status from ${application.status} to ${status || "an empty status"}`
        )
      );
    }

    if (!Array.isArray(application.statusHistory)) {
      application.statusHistory = [{
        status: application.status,
        date: application.createdAt || new Date()
      }];
    }
    application.status = status;
    application.statusHistory.push({ status, date: new Date() });
    await application.save();

    return res.json(response(true, "Status updated successfully", application));
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    if (!application) {
      return res.status(404).json(response(false, "Application not found"));
    }

    if (application.status === "Interview" || application.status === "Offer") {
      return res.status(400).json(
        response(
          false,
          "Cannot delete an application in Interview or Offer status"
        )
      );
    }

    await application.deleteOne();
    return res.json(response(true, "Application deleted successfully", null));
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
