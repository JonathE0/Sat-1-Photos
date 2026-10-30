// Settings for the CTS-SAT-1 picture gallery.
// This file is optional: if it is missing, the site uses the values below.
window.CTS1_CONFIG = {
  // The gallery's GitHub repository. When it is set, copies of the site that
  // run without serve.py (where editing is off) show a "Suggest a correction"
  // link on each picture, which opens a prefilled GitHub issue. "" hides it.
  repoUrl: "https://github.com/JonathE0/Sat-1-Photos",

  // When the scheduled update rebuilds the picture list, as the footer says
  // it ("It is rebuilt <refreshSchedule> from the pipeline…"). Keep it in
  // step with the schedule that publishes this copy:
  // .github/workflows/publish.yml on GitHub Pages, or
  // scripts/install-schedule.ps1 on a local machine. "" hides that line, for
  // a copy that is only as current as its last push.
  refreshSchedule: "twice a day, at 10 AM and 10 PM Calgary time",

  // The picture that stays still on the opening screen, by its id (the end
  // of its #/photo/ link). "" uses the newest detailed picture.
  heroPicture: "2026-08-06",
};
