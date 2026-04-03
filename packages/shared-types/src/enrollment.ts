export interface EnrollmentResponse {
  id: string;
  userId: string;
  courseId: string;
  enrolledAt: string;
  quizAccessUntil: string;
  videoAccessUntil: string;
  createdBy: string;
  updatedAt: string;
}

export interface CreateEnrollmentRequest {
  userId: string;
  courseId: string;
  enrolledAt: string;
}

export interface UpdateEnrollmentRequest {
  quizAccessUntil?: string;
  videoAccessUntil?: string;
}

export interface BulkCreateEnrollmentRequest {
  userIds: string[];
  courseId: string;
  enrolledAt: string;
}
