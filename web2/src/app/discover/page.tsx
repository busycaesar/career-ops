import { SavePostingForm } from "@/components/discover/save-posting-form";
import { JobPreferencesPanel } from "@/components/discover/job-preferences";
import { readJobPreferences } from "@/lib/preferences";

export const dynamic = "force-dynamic";

export default function DiscoverPage() {
  const preferences = readJobPreferences();
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-2xl font-semibold">Discover</h1>
      <SavePostingForm />
      <JobPreferencesPanel initial={preferences} />
    </div>
  );
}
