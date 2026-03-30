import type { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

type Role = "admin" | "teacher" | "student";

export type AuthUser = {
  id: string;
  role: Role;
  email?: string;
  firebaseUid?: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const requireUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.user.role !== "admin") {
    logger.warn("Admin access denied", {
      userId: req.user.id,
      email: req.user.email,
      role: req.user.role,
      path: req.originalUrl,
    });
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
};
