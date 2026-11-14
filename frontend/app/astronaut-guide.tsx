"use client";

import { useId } from "react";
import { useLanguage } from "./language";
import styles from "./astronaut-guide.module.css";

const messages = {
  en: {
    title: "Astronaut guide",
    close: "Close astronaut guide",
    greeting: "What would you like to explore?",
    questions: [
      ["How do I compare sites or dates?", "In the saved results, choose a week to compare Odysseus with Athena. Choose a site to compare its two weeks. Each bar shows when the model places both the Sun and Earth above that site’s horizon."],
      ["Can I see what’s happening now?", "Check the UTC window on the result. The saved weeks show modeled conditions for those dates. This guide has no live feed."],
      ["Does seeing Earth guarantee a radio link?", "Earth visibility tells you whether Earth is in view. Signal strength also depends on the radio equipment and the link conditions. The comparison gives no signal-strength estimate."],
    ],
    saved: "Go to saved comparisons",
  },
  vi: {
    title: "Hướng dẫn của phi hành gia",
    close: "Đóng hướng dẫn của phi hành gia",
    greeting: "Bạn muốn tìm hiểu điều gì?",
    questions: [
      ["Làm sao so sánh địa điểm hoặc thời gian?", "Trong phần kết quả đã lưu, chọn một tuần để so sánh Odysseus với Athena. Chọn một địa điểm để so sánh hai tuần tại đó. Mỗi thanh biểu thị khoảng thời gian mà theo mô hình, cả Mặt Trời và Trái Đất đều ở phía trên đường chân trời tại địa điểm đó."],
      ["Tôi xem được tình hình hiện tại không?", "Hãy xem khoảng thời gian UTC ghi trên kết quả. Các tuần đã lưu cho biết điều kiện theo mô hình trong những ngày đó. Hướng dẫn này không có dữ liệu trực tiếp."],
      ["Nhìn thấy Trái Đất có bảo đảm liên lạc vô tuyến không?", "Việc nhìn thấy Trái Đất cho biết Trái Đất nằm trong tầm nhìn. Cường độ tín hiệu còn phụ thuộc vào thiết bị vô tuyến và điều kiện đường truyền. Công cụ so sánh không ước tính cường độ tín hiệu."],
    ],
    saved: "Đến phần so sánh kết quả đã lưu",
  },
};

export default function AstronautGuide() {
  const { locale } = useLanguage();
  const copy = messages[locale];
  const id = useId();
  return <>
    <button type="button" className={styles.launcher} popoverTarget={id} aria-label={copy.title} title={copy.title}>
      <span aria-hidden="true">🧑‍🚀</span>
    </button>
    <aside id={id} popover="auto" className={styles.panel} aria-labelledby={id + "-title"}>
      <header className={styles.header}>
        <h2 id={id + "-title"}>{copy.title}</h2>
        <button type="button" className={styles.close} popoverTarget={id} popoverTargetAction="hide" aria-label={copy.close}>×</button>
      </header>
      <p className={styles.greeting}>{copy.greeting}</p>
      {copy.questions.map(([question, answer], index) =>
        <details key={index} name={id}>
          <summary>{question}</summary>
          <p>{answer}</p>
        </details>
      )}
      <a className={styles.jump} href="#observed-week" onClick={event => event.currentTarget.closest("aside")?.hidePopover()}>{copy.saved}</a>
    </aside>
  </>;
}
