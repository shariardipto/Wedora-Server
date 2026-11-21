import { ObjectId } from "mongodb";
import { notFound } from "./api-error.js";

/**
 * Parses a route id. Malformed ids are treated exactly like missing records
 * (404) so callers can't probe the id space.
 */
export function parseObjectId(value: unknown, label = "Record"): ObjectId {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    throw notFound(`${label} not found.`, `${label.toUpperCase().replace(/\s+/g, "_")}_NOT_FOUND`);
  }
  return new ObjectId(value);
}
