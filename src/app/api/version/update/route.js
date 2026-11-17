export async function POST() {
  return Response.json({ error: "Automatic updates are disabled in TokYard alpha. Follow the repository upgrade instructions." }, { status: 410 });
}
