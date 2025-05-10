use mailparse::*;
fn parse_email(raw: &[u8]) -> Result<ParsedMail, mailparseError> {
    let parse_mail = parse_mail(raw);
    return parse_mail;
}
