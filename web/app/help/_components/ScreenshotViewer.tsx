"use client";

import { useState } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import type { HelpScreenshot } from "../_data/help-sections";

export function ScreenshotViewer({
  screenshots,
}: {
  screenshots: HelpScreenshot[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (screenshots.length === 0) return null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {screenshots.map((ss) => (
          <button
            key={ss.src}
            type="button"
            onClick={() => setOpen(ss.src)}
            className="group overflow-hidden rounded-lg border bg-muted/30 transition hover:border-primary/40"
          >
            <div className="relative aspect-video w-full">
              <Image
                src={ss.src}
                alt={ss.alt}
                fill
                className="object-cover object-top transition group-hover:scale-[1.02]"
                sizes="(max-width: 640px) 100vw, 50vw"
                unoptimized
              />
            </div>
            <p className="px-3 py-2 text-xs text-muted-foreground text-left">
              {ss.caption}
            </p>
          </button>
        ))}
      </div>

      <Dialog open={open !== null} onOpenChange={() => setOpen(null)}>
        <DialogContent className="max-w-4xl p-2">
          <DialogTitle className="sr-only">
            スクリーンショット
          </DialogTitle>
          {open && (
            <div className="relative aspect-video w-full">
              <Image
                src={open}
                alt="スクリーンショット拡大"
                fill
                className="rounded object-contain"
                sizes="90vw"
                unoptimized
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
