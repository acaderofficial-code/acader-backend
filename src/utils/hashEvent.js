import crypto from "crypto";

const sortValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }

  return value;
};

export const stableStringify = (value) => JSON.stringify(sortValue(value));

export const generateEventHash = (eventData, previousHash = "GENESIS") => {
  const baseHash =
    typeof previousHash === "string" && previousHash.length > 0
      ? previousHash
      : "GENESIS";
  const canonicalPayload = stableStringify(eventData ?? {});
  return crypto
    .createHash("sha256")
    .update(`${baseHash}:${canonicalPayload}`, "utf8")
    .digest("hex");
};
