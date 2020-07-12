const { Setting } = require("../../../models");

export default async (req, res) => {
  if (req.method === "GET") {
    return Setting.findAll().then(res.json).catch(res.json);
  }

  if (req.method === "POST") {
    return Setting.create({ type: req.body.type, data: req.body.data })
      .then(() => Setting.findAll())
      .then(res.json)
      .catch(res.json);
  }
};