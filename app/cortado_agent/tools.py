"""
Cortado Agent Tools

Custom tools for the Cortado support agent.

Tools:
  - google_search (built-in ADK tool, configured in agent.py)
  - create_support_ticket: Log a support interaction, email the summary, and
    generate a ticket. Supports optional image descriptions for visual records.
"""

import datetime
import logging
import os
import uuid

import resend

logger = logging.getLogger(__name__)

# In-memory ticket store (persists for the lifetime of the server process)
tickets_store: list[dict] = []

# Resend email config
resend.api_key = os.getenv("RESEND_API_KEY", "")
FROM_EMAIL = "Cortado Support <onboarding@resend.dev>"


def _send_ticket_email(ticket: dict) -> bool:
    """Send a formatted ticket summary email via Resend."""
    if not resend.api_key:
        logger.warning("RESEND_API_KEY not set — skipping email")
        return False

    status_emoji = {
        "resolved": "✅",
        "escalated": "⚠️",
        "pending": "🔄",
    }.get(ticket["resolution_status"], "📋")

    priority_label = ticket["priority"].upper()

    # Determine domain from ticket prefix
    ticket_id = ticket["ticket_id"]
    is_garmin = ticket_id.startswith("GRM-")
    brand_name = "Garmin Watches" if is_garmin else "Wahoo Fitness"
    support_url = (
        "https://support.garmin.com/en-US/"
        if is_garmin
        else "https://support.wahoofitness.com"
    )

    # Build the image observation section (Garmin tickets include this)
    image_section = ""
    if ticket.get("include_image") and ticket.get("image_observations"):
        image_section = f"""
            <div style="margin-bottom: 16px; background: #f0f4f8; border-radius: 8px; padding: 16px; border-left: 4px solid #ff426f;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #9b9488; margin-bottom: 6px;">📷 Visual Record</div>
                <p style="font-size: 14px; line-height: 1.6; color: #2d2a24; margin: 0;">{ticket["image_observations"]}</p>
            </div>
        """

    html = f"""
    <div style="font-family: 'Inter', -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background: #faf9f5; padding: 24px;">
        <div style="background: #ffffff; border-radius: 12px; padding: 28px; border: 1px solid #ede8df;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="font-size: 22px; margin: 0; color: #ff426f;">Cortado Support</h1>
                <p style="font-size: 12px; color: #9b9488; margin-top: 4px;">{brand_name} — Support Ticket Summary</p>
            </div>

            <hr style="border: none; border-top: 1px solid #ede8df; margin: 16px 0;">

            <table style="width: 100%; font-size: 14px; color: #2d2a24;">
                <tr>
                    <td style="padding: 8px 0; color: #9b9488; width: 130px;">Ticket ID</td>
                    <td style="padding: 8px 0; font-weight: 600; font-family: monospace; color: #ff426f;">{ticket["ticket_id"]}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #9b9488;">Date</td>
                    <td style="padding: 8px 0;">{datetime.datetime.fromisoformat(ticket["created_at"]).strftime("%B %d, %Y at %I:%M %p")}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #9b9488;">Product</td>
                    <td style="padding: 8px 0; font-weight: 500;">{ticket["product_model"]}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #9b9488;">Priority</td>
                    <td style="padding: 8px 0;">{priority_label}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #9b9488;">Status</td>
                    <td style="padding: 8px 0; font-weight: 600;">{status_emoji} {ticket["resolution_status"].upper()}</td>
                </tr>
            </table>

            <hr style="border: none; border-top: 1px solid #ede8df; margin: 16px 0;">

            <div style="margin-bottom: 16px;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #9b9488; margin-bottom: 6px;">Issue Summary</div>
                <p style="font-size: 14px; line-height: 1.6; color: #2d2a24; margin: 0;">{ticket["issue_summary"]}</p>
            </div>

            {image_section}

            <div style="margin-bottom: 16px;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #9b9488; margin-bottom: 6px;">Resolution Notes</div>
                <p style="font-size: 14px; line-height: 1.6; color: #2d2a24; margin: 0;">{ticket["resolution_notes"]}</p>
            </div>

            <hr style="border: none; border-top: 1px solid #ede8df; margin: 16px 0;">

            <p style="font-size: 12px; color: #9b9488; text-align: center; margin: 0;">
                Need more help? Reference ticket <strong>{ticket["ticket_id"]}</strong> when contacting
                <a href="{support_url}" style="color: #ff426f;">{brand_name} Support</a>.
            </p>
        </div>
        <p style="font-size: 11px; color: #9b9488; text-align: center; margin-top: 16px;">
            Powered by Cortado AI — Multimodal Support Agent
        </p>
    </div>
    """

    try:
        result = resend.Emails.send(
            {
                "from": FROM_EMAIL,
                "to": [ticket["customer_email"]],
                "subject": f"Support Ticket {ticket['ticket_id']} — {ticket['issue_summary']}",
                "html": html,
            }
        )
        logger.info(f"Email sent for ticket {ticket['ticket_id']}: {result}")
        return True
    except Exception as e:
        logger.error(f"Failed to send email for ticket {ticket['ticket_id']}: {e}")
        return False


def create_support_ticket(
    customer_email: str,
    issue_summary: str,
    product_model: str,
    resolution_status: str,
    resolution_notes: str,
    priority: str = "medium",
    include_image: bool = False,
    image_observations: str = "",
) -> dict:
    """Create a support ticket to log this interaction. Call this at the end of
    every support conversation to record the issue and resolution.

    Args:
        customer_email: Customer's email address for sending the ticket summary.
        issue_summary: One-line description of the customer's issue.
        product_model: Product involved (e.g. "KICKR CORE 2", "Garmin Fenix 7X").
        resolution_status: Outcome — "resolved", "escalated", or "pending".
        resolution_notes: What was tried, what worked or didn't, and next steps.
        priority: Ticket priority — "low", "medium", "high", or "critical".
        include_image: Set to true if images or camera frames were shared during
            the session. When true, image_observations will be included in the
            ticket email as a visual record.
        image_observations: Description of what was observed in the customer's
            images or camera feed — model identification, visible damage, screen
            state, sensor condition, etc. Only used when include_image is true.

    Returns:
        dict with ticket_id, confirmation message, and full ticket details.
    """
    # Determine ticket prefix based on product
    product_lower = product_model.lower()
    if any(
        kw in product_lower
        for kw in ["garmin", "fenix", "forerunner", "venu", "instinct", "epix", "enduro", "tactix", "descent", "marq"]
    ):
        prefix = "GRM"
    else:
        prefix = "WAH"

    ticket_id = (
        f"{prefix}-{datetime.datetime.now().strftime('%Y%m%d')}-"
        f"{uuid.uuid4().hex[:6].upper()}"
    )

    ticket = {
        "ticket_id": ticket_id,
        "created_at": datetime.datetime.now().isoformat(),
        "customer_email": customer_email,
        "product_model": product_model,
        "issue_summary": issue_summary,
        "resolution_status": resolution_status,
        "resolution_notes": resolution_notes,
        "priority": priority,
        "include_image": include_image,
        "image_observations": image_observations,
    }

    tickets_store.append(ticket)

    # Send the real email
    email_sent = _send_ticket_email(ticket)

    return {
        "ticket_id": ticket_id,
        "status": "created",
        "email_sent": email_sent,
        "message": (
            f"Support ticket {ticket_id} created successfully. "
            f"{'A summary has been emailed to' if email_sent else 'Could not email'} "
            f"{customer_email}."
            + (" Visual record included in ticket." if include_image else "")
        ),
        "ticket": ticket,
    }
