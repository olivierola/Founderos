import * as React from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

// Shape the Plate media nodes read from `uploadedFile`.
export interface UploadedFile {
  key: string;
  url: string;
  name: string;
  size: number;
  type: string;
}

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
}

const BUCKET = "office-media";

// Uploads editor media to Supabase Storage (public bucket) and returns a public
// URL. Replaces the original uploadthing-based hook from the Plate registry.
export function useUploadFile({ onUploadComplete, onUploadError }: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  async function uploadFile(file: File): Promise<UploadedFile | undefined> {
    setIsUploading(true);
    setUploadingFile(file);
    setProgress(10);
    try {
      const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
      const path = `${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || undefined,
      });
      if (error) throw error;
      setProgress(90);

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const result: UploadedFile = {
        key: path,
        url: data.publicUrl,
        name: file.name,
        size: file.size,
        type: file.type,
      };
      setUploadedFile(result);
      setProgress(100);
      onUploadComplete?.(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed. Please try again.";
      toast.error(message);
      onUploadError?.(error);
      return undefined;
    } finally {
      setProgress(0);
      setIsUploading(false);
      setUploadingFile(undefined);
    }
  }

  return { isUploading, progress, uploadedFile, uploadFile, uploadingFile };
}

export function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return "Something went wrong, please try again later.";
}

export function showErrorToast(err: unknown) {
  return toast.error(getErrorMessage(err));
}
