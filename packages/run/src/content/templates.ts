/**
 * Authored text for content (PLAY-002 §5.1). R5 (#117) owns this file; Philip edits the wording.
 *
 * Ids are "card.<card_id>.<part>", with the card's dashes written as underscores. Shared cards
 * (rent notices, courses, pay rises) share one set of text and differ only in their numbers.
 * `{pay}` and friends are the formatted twins of slots such as `payMinor`; `{business}` is the
 * name of the business a business card is about. Short and plain, because money worries are not
 * a joke.
 */
export const TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  // -- side jobs ---------------------------------------------------------------------------
  "card.side_job_moving.title": [
    "A neighbour needs help moving",
    "Moving help wanted this Saturday",
  ],
  "card.side_job_moving.body": [
    "Six hours of carrying boxes, {pay} cash on the day.",
    "Someone down the road is moving flat. They will pay {pay} for a day of lifting.",
  ],
  "card.side_job_moving.take": ["Take it: 6 hours, {pay}"],

  "card.side_job_tutoring.title": ["A student needs a tutor", "Tutoring work is available"],
  "card.side_job_tutoring.body": [
    "A parent asks if you can help their child with exams. It is a few evenings and pays {pay}.",
    "You have been asked to tutor this month. The pay is {pay} for four hours.",
  ],
  "card.side_job_tutoring.take": ["Take it: 4 hours, {pay}"],

  "card.side_job_delivery.title": ["Delivery shifts on offer", "Evening deliveries need riders"],
  "card.side_job_delivery.body": [
    "A delivery app has evening shifts. About {pay} for eight hours, if your bike holds up.",
    "You can ride deliveries this week for around {pay}. A repair now and then is part of it.",
  ],
  "card.side_job_delivery.take": [
    "Take the shifts: 8 hours, {pay}, and a small chance of a {repair} repair",
  ],

  "card.side_sell_old_things.title": ["Time to clear some space", "Things you no longer use"],
  "card.side_sell_old_things.body": [
    "You could sell what you do not use. Everything might fetch {all}. A few good pieces would bring {few}.",
    "There are things at home that you have not touched in months. Selling them all could bring {all}.",
  ],
  "card.side_sell_old_things.all": ["Sell it all: 3 hours, {all}"],
  "card.side_sell_old_things.few": ["Sell a few things: 1 hour, {few}"],

  "card.side_weekend_event.title": ["Weekend event work", "Staff needed at a weekend event"],
  "card.side_weekend_event.body": [
    "An events company needs help setting up and running a weekend. The pay is {pay}, and tips are sometimes shared.",
    "Two long days at an event. They offer {pay}, and there may be tips on top.",
  ],
  "card.side_weekend_event.take": ["Take it: 12 hours, {pay} and maybe tips"],

  "card.side_job_freelance_design.title": [
    "A friend needs a design",
    "Someone asks for your design skills",
  ],
  "card.side_job_freelance_design.body": [
    "A small business wants a logo and a flyer. They suggest {pay}. You could ask for {high}.",
    "Someone has seen your work and wants a design. They offer {pay}. You think it is worth {high}.",
  ],
  "card.side_job_freelance_design.take": ["Say yes to {pay}: 10 hours"],
  "card.side_job_freelance_design.ask_more": [
    "Ask for {high}: 10 hours, they may say no and walk away",
  ],

  "card.overtime_offer.title": ["Extra shifts at work", "Your manager needs cover"],
  "card.overtime_offer.body": [
    "Your manager asks if you can work extra hours this week. It pays {pay} on top of your salary.",
    "A colleague is away and there are extra shifts to cover. You would earn {pay}.",
  ],
  "card.overtime_offer.take": ["Take the shifts: 8 hours, {pay}"],

  // -- life events -------------------------------------------------------------------------
  "card.surprise_dentist.title": ["Toothache"],
  "card.surprise_dentist.body": ["The dentist can see you today. The work will cost {cost}."],
  "card.surprise_dentist.pay": ["Pay now: {cost}"],
  "card.surprise_dentist.bill": ["Ask for a bill in two weeks: {cost}"],

  "card.phone_breaks.title": ["Your phone breaks", "The screen is cracked"],
  "card.phone_breaks.body": [
    "You dropped your phone and it will not turn on. A repair would cost {repair}. A second-hand one is {used}. A new one is {fresh}.",
    "Your phone has stopped working. You can repair it for {repair}, buy second-hand for {used}, or buy new for {fresh}.",
  ],
  "card.phone_breaks.repair": ["Repair it: {repair}"],
  "card.phone_breaks.used": ["Buy a second-hand one: 2 hours, {used}"],
  "card.phone_breaks.fresh": ["Buy a new one now: {fresh}"],
  "card.phone_breaks.later": ["Buy a new one and pay in two weeks: {fresh}"],

  "card.friend_wedding.title": ["A friend is getting married", "You are invited to a wedding"],
  "card.friend_wedding.body": [
    "A close friend invites you to their wedding. A proper gift is about {gift}. Getting there costs {travel}.",
    "You have been invited to a wedding far away. The trip is {travel}. A gift is around {gift}, or {modest} if you keep it small.",
  ],
  "card.friend_wedding.full": ["Go with a proper gift: 8 hours, {gift} and {travel} to get there"],
  "card.friend_wedding.modest": [
    "Go with a small gift: 8 hours, {modest} and {travel} to get there",
  ],

  "card.birthday_money.title": ["Birthday money", "A card in the post"],
  "card.birthday_money.body": [
    "Your family sent you {gift} for your birthday.",
    "A card arrived with {gift} inside. Happy birthday.",
  ],
  "card.birthday_money.keep": ["Keep it all: {gift}"],

  "card.laptop_repair.title": ["Your laptop stops working", "The laptop needs repairing"],
  "card.laptop_repair.body": [
    "Your laptop will not start. The repair shop says it will cost {cost}.",
    "Your laptop broke down. A repair is {cost}, and you need it for work.",
  ],
  "card.laptop_repair.fix": ["Pay for the repair: {cost}"],
  "card.laptop_repair.bill": ["Get it fixed and pay in two weeks: {cost}"],

  "card.bike_stolen.title": ["Your bike is gone", "Someone stole your bike"],
  "card.bike_stolen.body": [
    "You come out and the bike is not there. A used one costs about {bike}. Or you can use public transport for {pass}.",
    "Your bike was stolen. You can buy a used one for {bike}, or pay {pass} for extra travel passes.",
  ],
  "card.bike_stolen.bike": ["Buy a used bike: {bike}"],
  "card.bike_stolen.pass": ["Use buses and trains for now: {pass}"],

  "card.medical_visit.title": ["A visit to the doctor", "You are not feeling well"],
  "card.medical_visit.body": [
    "You need to see a doctor and get some medicine. It comes to {cost}.",
    "A check-up and a prescription. The total is {cost}.",
  ],
  "card.medical_visit.pay": ["Pay now: {cost}"],
  "card.medical_visit.plan": ["Pay in three weeks: {cost}"],

  "card.travel_fine.title": ["A fine in the post", "You have a travel fine"],
  "card.travel_fine.body": [
    "An inspector says your ticket was not valid. The fine is {fine}.",
    "A letter arrives about a travel fine of {fine}. You can pay it or appeal.",
  ],
  "card.travel_fine.pay": ["Pay the fine: {fine}"],

  "card.group_trip.title": ["Your friends plan a trip", "A weekend away"],
  "card.group_trip.body": [
    "Friends are going away for a weekend. Your share is {trip}. They would also love to see you for just a day, which is {day}.",
    "A group of friends is planning a trip. The weekend costs {trip}. A day out costs {day}.",
  ],
  "card.group_trip.trip": ["Join the weekend away: 12 hours, {trip}"],
  "card.group_trip.day": ["Join for the day only: 6 hours, {day}"],

  // -- rent notices (shared by every starting point) -----------------------------------------
  "card.rent_notice.title": ["Rent notice", "A letter from your landlord"],
  "card.rent_notice.body": [
    "Your landlord is raising the rent to {newRent} a month. That is {extra} more than now.",
    "From next month your rent will be {newRent}, which is {extra} more.",
  ],
  "card.rent_notice.accept": ["Accept the new rent: {newRent} a month"],

  // -- opportunities -------------------------------------------------------------------------
  "card.evening_course.title": ["An evening course", "A chance to learn something new"],
  "card.evening_course.body": [
    "A course in the evenings could help you move up at work. It costs {cost} and about five hours of your week.",
    "You could sign up for an evening course. It costs {cost} now. If you finish, your manager may offer you more.",
  ],
  "card.evening_course.enrol": ["Sign up: 5 hours, {cost}, and a possible raise later"],

  "card.pay_rise.title": ["Good news from work", "Your manager wants to talk"],
  "card.pay_rise.body": [
    "Since you finished the course, your manager would like to raise your pay to {newPay} a month.",
    "Your manager says the course made a difference. They offer a new salary of {newPay} a month.",
  ],
  "card.pay_rise.accept": ["Accept {newPay} a month"],
  "card.pay_rise.ask_more": [
    "Ask for more: it might work, or the offer might be withdrawn and your pay stays as it is",
  ],

  "card.studio_idea.title": ["An idea for a small studio", "Could you work for yourself?"],
  "card.studio_idea.body": [
    "People keep asking you for design work. You could open a small studio. About €800 of your own money would cover a better laptop, software and a simple website.",
    "You have thought about working for yourself in the evenings. €800 from your savings would get a small studio started. It is your risk, and your reward.",
  ],

  "card.stall_offer.title": ["A market stall is available", "Take over a stall?"],
  "card.stall_offer.body": [
    "A trader you know is retiring and offers you their stall. You would put in €1,000 for stock and a float. What you earn depends on how much you sell.",
    "A market stall could be yours. It needs €1,000 to start. There will be quiet days as well as busy ones.",
  ],

  "card.bank_invites.title": ["Your bank has an offer", "A letter from the bank"],
  "card.bank_invites.body": [
    "Your bank says you have looked after your money well. They offer you a loan. You would pay it back with interest.",
    "Because you pay on time, the bank invites you to borrow. A loan adds to your cash now, and costs more later.",
  ],

  "card.payday_flyer.title": ["A flyer for quick cash", "Money fast, no questions"],
  "card.payday_flyer.body": [
    "Your cash is low and a flyer offers a quick loan. It is easy to get, and it is expensive to keep. You could also find cash work for {earn}.",
    "A quick cash lender is advertising near you. Borrowing is fast. You could earn {earn} from some cash work instead.",
  ],
  "card.payday_flyer.work": ["Pick up cash work: 6 hours, {earn}"],

  "card.family_help.title": ["Your family offers to help", "A call from home"],
  "card.family_help.body": [
    "Your family knows money is tight. They offer to lend you €500. You would pay it back when you can.",
    "A relative says they can lend you some money until things settle. It is a loan, not a gift.",
  ],

  // -- business: service -----------------------------------------------------------------------
  "card.client_long_terms.title": ["A big job with slow payment", "A large client on 60-day terms"],
  "card.client_long_terms.body": [
    "A client wants a big job for {business}. It pays {job}. They pay 60 days after the work is done. You need about {cost} for costs along the way.",
    "{business} has a chance at a large project worth {job}. The client pays after 60 days. Costs of {cost} come first.",
  ],
  "card.client_long_terms.accept": [
    "Take it on 60-day terms: 12 hours, {cost} of costs now, {job} in about two months",
  ],
  "card.client_long_terms.ask_30": ["Ask for 30 days: 12 hours, the client may agree or walk away"],

  "card.client_discount.title": ["A client asks for a lower price", "Can you do it for less?"],
  "card.client_discount.body": [
    "A client likes the work from {business} but says {full} is too much. They would pay {reduced}.",
    "A client for {business} asks you to drop your price from {full} to {reduced}.",
  ],
  "card.client_discount.hold": ["Hold your price of {full}: 3 hours, they may agree or leave"],
  "card.client_discount.accept": ["Accept {reduced}"],

  "card.client_referral.title": ["A client sends a friend your way", "A referral for {business}"],
  "card.client_referral.body": [
    "A happy client has told a friend about {business}. The friend has a job worth {job}.",
    "Someone recommended {business}. A new client offers {job} for a small project.",
  ],
  "card.client_referral.take": ["Take the job: 8 hours, {job} in about three weeks"],

  // -- business: stock ---------------------------------------------------------------------------
  "card.festival_weekend.title": ["A festival weekend", "A big crowd is coming"],
  "card.festival_weekend.body": [
    "A festival is coming to town, and {business} could have a pitch. A big stock-up costs {stock} and can bring {good} if the weather is good. In rain, sales may be only {rain}.",
    "{business} could trade at a festival. Spend {stock} on stock for a good weekend worth {good}, or about {rain} if it rains.",
  ],
  "card.festival_weekend.big": [
    "Stock up big: 14 hours, {stock} of stock, and the weather decides the rest",
  ],
  "card.festival_weekend.small": [
    "Run a small stand: 6 hours, €80 of stock, about {small} in sales",
  ],

  "card.supplier_problem.title": ["A problem with your supplier", "Prices go up at your supplier"],
  "card.supplier_problem.body": [
    "Your supplier says the next delivery for {business} will cost {extra} more.",
    "A price rise at the supplier for {business}: {extra} extra on the next delivery.",
  ],
  "card.supplier_problem.pay": ["Pay the extra {extra}"],
};
