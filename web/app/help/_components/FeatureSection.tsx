"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertBox } from "@/components/ui/alert-box";
import type { HelpSection } from "../_data/help-sections";
import { roleLabels } from "../_data/help-sections";
import { StepList } from "./StepList";
import { ScreenshotViewer } from "./ScreenshotViewer";

const roleBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  student: "secondary",
  admin: "default",
  super: "outline",
};

export function FeatureSection({ section }: { section: HelpSection }) {
  return (
    <section id={section.id} className="scroll-mt-24">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-xl">{section.title}</CardTitle>
            {section.roles.length < 3 &&
              section.roles.map((role) => (
                <Badge key={role} variant={roleBadgeVariant[role]}>
                  {roleLabels[role]}
                </Badge>
              ))}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {section.description}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <ScreenshotViewer screenshots={section.screenshots} />

          {section.steps.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                操作手順
              </h3>
              <StepList steps={section.steps} />
            </div>
          )}

          {section.callouts.map((callout, i) => (
            <AlertBox
              key={i}
              variant={callout.variant === "success" ? "success" : callout.variant}
              title={callout.title}
            >
              {callout.content}
            </AlertBox>
          ))}

          {section.faqs && section.faqs.length > 0 && (
            <div className="space-y-2">
              {section.faqs.map((faq, i) => (
                <details
                  key={i}
                  className="group rounded-lg border px-4 py-3"
                >
                  <summary className="cursor-pointer font-medium list-none flex items-center justify-between">
                    <span>{faq.question}</span>
                    <span className="ml-2 text-muted-foreground transition-transform group-open:rotate-180">
                      &#9662;
                    </span>
                  </summary>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {faq.answer}
                  </p>
                </details>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
